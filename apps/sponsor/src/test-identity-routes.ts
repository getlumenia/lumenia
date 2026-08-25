/**
 * ============================================================================
 *  TEST — the identity ROUTES, driven through the Worker's own front door
 * ============================================================================
 *
 *  test-identity.ts proves the registries. This proves the WIRING: that a real Request reaching
 *  `worker.fetch` is parsed, authorized and answered the way the client expects — the layer where
 *  a renamed body field or a forgotten `nonce` silently refuses every user while every unit test
 *  stays green.
 *
 *  DELIBERATELY ISOLATED FROM ANY REAL STORE. The env handed to the Worker below carries a
 *  throwaway sponsor key and NO `KV_REST_API_*`, so both registries fall back to their in-memory
 *  maps. Running this must never touch the production store — a smoke test that registers `@meric`
 *  in the live registry would be a bug, not a test.
 *
 *  RUN: pnpm --filter @lumenia/sponsor test:identity-routes   (no network, no live keys)
 * ============================================================================
 */
import { Keypair } from "@stellar/stellar-sdk";
import worker from "./worker.js";
import { handleProofMessage, proofNonce } from "./lib/handles.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

/** A sponsor identity that exists only for this process. Nothing is ever signed or submitted. */
const ENV = {
  STELLAR_NETWORK: "testnet",
  SPONSOR_SECRET: Keypair.random().secret(),
  USDC_ISSUER: Keypair.random().publicKey(),
  ALLOWED_ORIGIN: "https://getlumenia.com",
  FEDERATION_DOMAIN: "getlumenia.com",
};

const BASE = "https://sponsor.test";
const alice = Keypair.random();
const bob = Keypair.random();

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const request = new Request(`${BASE}${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const res = await worker.fetch(request, ENV);
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text.slice(0, 120) };
  }
  return { status: res.status, json };
}

function signed(kp: Keypair, action: "claim" | "release" | "links", name: string) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = proofNonce();
  const message = handleProofMessage(action, name, kp.publicKey(), ts, nonce, "testnet");
  return {
    name,
    pubkey: kp.publicKey(),
    ts,
    nonce,
    proof: kp.sign(Buffer.from(message, "utf8")).toString("base64"),
  };
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log(" IDENTITY ROUTE TESTS — through worker.fetch (isolated store)");
  console.log("============================================================\n");

  console.log("[1] the name registry over HTTP");
  const free = await call("GET", "/handle?name=meric");
  ok("an unclaimed name 404s as available", free.status === 404 && free.json.available === true);
  const reserved = await call("GET", "/handle?name=support");
  ok("a reserved name 404s as unavailable", reserved.status === 404 && reserved.json.available === false);
  ok("and says why", typeof reserved.json.error === "string", String(reserved.json.error));

  const claim = await call("POST", "/handle-claim", signed(alice, "claim", "meric"));
  ok("alice claims @meric", claim.status === 200, JSON.stringify(claim.json).slice(0, 60));

  const taken = await call("GET", "/handle?name=meric");
  ok("it now resolves", taken.status === 200 && taken.json.address === alice.publicKey());
  const reverse = await call("GET", `/handle-of?pubkey=${alice.publicKey()}`);
  ok("the reverse resolves", reverse.status === 200 && reverse.json.name === "meric");

  const stolen = await call("POST", "/handle-claim", signed(bob, "claim", "meric"));
  ok("bob cannot take it", stolen.status === 409, String(stolen.json.error));
  const lookalike = await call("POST", "/handle-claim", signed(bob, "claim", "mer1c"));
  ok("nor a lookalike", lookalike.status === 409, String(lookalike.json.error));

  // The nonce is what separates "the same request twice" from "a replayed signature". A route that
  // drops it from the body would refuse every claim; this is the check that would catch it.
  const noNonce = { ...signed(bob, "claim", "deniz"), nonce: "" };
  ok("a proof with no nonce is refused", (await call("POST", "/handle-claim", noNonce)).status === 409);

  console.log("\n[2] federation over HTTP");
  const fed = await call("GET", "/federation?q=meric*getlumenia.com&type=name");
  ok("name → account", fed.status === 200 && fed.json.account_id === alice.publicKey());
  ok(
    "and answers in SEP-0002 shape",
    fed.json.stellar_address === "meric*getlumenia.com",
    String(fed.json.stellar_address),
  );
  const fedId = await call("GET", `/federation?q=${alice.publicKey()}&type=id`);
  ok("account → name", fedId.status === 200 && fedId.json.stellar_address === "meric*getlumenia.com");
  ok("an unknown name 404s", (await call("GET", "/federation?q=nobody*getlumenia.com&type=name")).status === 404);
  ok("an unsupported type 404s", (await call("GET", "/federation?q=x&type=txid")).status === 404);

  console.log("\n[3] ways back in over HTTP");
  const providers = await call("GET", "/identity-providers");
  ok("only the registration-free providers are offered", providers.status === 200, JSON.stringify(providers.json.providers));
  ok(
    "no OAuth provider is offered without an app",
    Array.isArray(providers.json.providers) && (providers.json.providers as string[]).length === 2,
  );
  const noApp = await call("POST", "/identity-start", { provider: "google" });
  ok("starting an unregistered provider fails honestly", noApp.status === 400, String(noApp.json.error));
  ok("an unknown provider is refused", (await call("POST", "/identity-start", { provider: "myspace" })).status === 400);

  const hex = (c: string) => c.repeat(64);
  const noProof = await call("POST", "/identity-check", {});
  ok("a check with no proof is refused", noProof.status === 400);
  const badProof = await call("POST", "/identity-check", { proof: { kind: "ticket", ticket: hex("a").slice(0, 48) } });
  ok("a check with an unknown ticket is refused", badProof.status === 401);

  const attach = await call("POST", "/identity-attach", {
    proof: { kind: "passkey", id: hex("c"), proof: hex("9") },
    address: alice.publicKey(),
    passkeyProof: hex("9"),
  });
  ok("alice connects a passkey", attach.status === 200, String(attach.json.error ?? ""));

  const check = await call("POST", "/identity-check", { proof: { kind: "passkey", id: hex("c"), proof: hex("9") } });
  ok("checking it reports connected", check.status === 200 && check.json.taken === true);
  ok("and names the account by handle", check.json.handle === "meric", String(check.json.handle));

  const steal = await call("POST", "/identity-attach", {
    proof: { kind: "passkey", id: hex("c"), proof: hex("9") },
    address: bob.publicKey(),
  });
  ok("bob cannot re-point it at himself", steal.status === 409);
  ok(
    "and the refusal carries the name the UI shows",
    (steal.json.conflict as { handle?: string } | undefined)?.handle === "meric",
  );

  const wrongProof = await call("POST", "/identity-attach", {
    proof: { kind: "passkey", id: hex("c"), proof: hex("8") },
    address: bob.publicKey(),
  });
  ok("a different PRF proof for that id is refused", wrongProof.status === 401);

  console.log("\n[4] an account's own connections are private to it");
  const unsigned = await call("POST", "/identity-links", { pubkey: alice.publicKey(), ts: 1, nonce: "aa", proof: "x" });
  ok("an unsigned listing is refused", unsigned.status === 401);
  const list = await call("POST", "/identity-links", signed(alice, "links", ""));
  ok("a signed listing is answered", list.status === 200, JSON.stringify(list.json.links));
  ok("and lists the passkey", JSON.stringify(list.json.links).includes("passkey"));

  const detachNotMine = await call("POST", "/identity-detach-mine", {
    ...signed(bob, "links", ""),
    provider: "passkey",
  });
  ok("bob's signature removes nothing of alice's", detachNotMine.status === 200 && detachNotMine.json.removed === 0);
  const stillThere = await call("POST", "/identity-check", { proof: { kind: "passkey", id: hex("c"), proof: hex("9") } });
  ok("alice's connection survived", stillThere.json.taken === true);

  const detachMine = await call("POST", "/identity-detach-mine", {
    ...signed(alice, "links", ""),
    provider: "passkey",
  });
  ok("alice removes her own", detachMine.status === 200 && detachMine.json.removed === 1);
  const gone = await call("POST", "/identity-check", { proof: { kind: "passkey", id: hex("c"), proof: hex("9") } });
  ok("and it is gone", gone.json.taken === false);

  console.log("\n[5] giving a name up, over HTTP");
  const release = await call("POST", "/handle-release", signed(alice, "release", "meric"));
  ok("the owner can release", release.status === 200);
  ok("it stops resolving", (await call("GET", "/handle?name=meric")).status === 404);
  const cooldown = await call("GET", "/handle?name=meric");
  ok("and is NOT offered as available during the cooldown", cooldown.json.available !== true, String(cooldown.json.error));
  const lookalikeFree = await call("GET", "/handle?name=mer1c");
  ok("a lookalike is not offered as available either", lookalikeFree.json.available !== true, String(lookalikeFree.json.error));

  console.log(`\n${failed === 0 ? "✅" : "❌"} IDENTITY ROUTE TESTS ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("\n💥 identity route test crashed:", e);
  process.exit(1);
});
