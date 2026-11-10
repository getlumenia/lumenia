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
import worker, { lookupCacheStatsForTests, resetLookupCache } from "./worker.js";
import { handleProofMessage, proofNonce } from "./lib/handles.js";
import { idForEmail } from "./lib/recovery-otp.js";
import { identityId, OAUTH_PROVIDERS } from "./lib/identity-links.js";
import { __resetMailBudgetForTests } from "./lib/mail-budget.js";

// Never a real store or a real mailer, whatever the shell exports (see the note above).
for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN", "RESEND_API_KEY"]) {
  delete process.env[k];
}

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
  // The email codes of section [6] are read from the local log line, as a developer reads them.
  RECOVERY_ALLOW_MEMORY_STORE: "1",
  // This suite asks more often than a person would; the limits are not what it tests.
  RATE_CAP: "1000",
  ACCOUNT_RATE_CAP: "1000",
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

/** The account's own authorization for an attach — the `links` proof, over the literal `attach`. */
function accountProof(kp: Keypair) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = proofNonce();
  const message = handleProofMessage("links", "attach", kp.publicKey(), ts, nonce, "testnet");
  return { ts, nonce, proof: kp.sign(Buffer.from(message, "utf8")).toString("base64") };
}

/** The account's own authorization to cut a link off it: the `links` proof, over `detach:<id>`. */
function detachProof(kp: Keypair, id: string) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = proofNonce();
  const message = handleProofMessage("links", `detach:${id}`, kp.publicKey(), ts, nonce, "testnet");
  return { ts, nonce, proof: kp.sign(Buffer.from(message, "utf8")).toString("base64") };
}

/** A backup write's owner proof: the `links` proof over the box id. */
function writeProof(kp: Keypair, id: string) {
  const ts = Math.floor(Date.now() / 1000);
  const nonce = proofNonce();
  const message = handleProofMessage("links", id, kp.publicKey(), ts, nonce, "testnet");
  return { pubkey: kp.publicKey(), ts, nonce, proof: kp.sign(Buffer.from(message, "utf8")).toString("base64") };
}

const BOX = {
  formatVersion: 1,
  copies: [{ kind: "password", iv: "AAAA", ct: "BBBB", salt: "CCCC", argon: { memMiB: 48, time: 2, parallelism: 1 } }],
};

/** Ask /recovery-otp for a code and read it off the local log line (no mailer in this suite). */
async function codeFor(email: string): Promise<string> {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  let res: { status: number; json: Record<string, unknown> };
  try {
    res = await call("POST", "/recovery-otp", { email });
  } finally {
    console.log = real;
  }
  const code = lines.map((l) => /\[recovery:otp\] \(local, no RESEND_API_KEY\) code for .*: (\d{6})$/.exec(l)?.[1]).find(Boolean);
  if (res.status !== 200 || !code) throw new Error(`no code for ${email}: ${res.status} ${JSON.stringify(res.json)}`);
  return code;
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

  // An attach is TWO agreements: `proof` is the identity's, and `accountProof` is the account
  // agreeing to be what that identity opens. BOTH halves belong here. A route that refuses
  // correctly and accepts nothing is indistinguishable from a route no user can get through, so
  // the 409 below is what a stranger must get and the 200 after it is what every "Connect Face ID"
  // needs. `accountProof` is the literal body key apps/web/lib/identity.ts sends — renaming it on
  // either side has to fail here rather than in front of a user.
  const unauthorized = await call("POST", "/identity-attach", {
    proof: { kind: "passkey", id: hex("c"), proof: hex("9") },
    address: alice.publicKey(),
    passkeyProof: hex("9"),
  });
  ok("an attach the account did not sign is refused", unauthorized.status === 409, String(unauthorized.json.error));
  ok(
    "and says so in words a screen can show",
    typeof unauthorized.json.error === "string",
    String(unauthorized.json.error),
  );

  const attach = await call("POST", "/identity-attach", {
    proof: { kind: "passkey", id: hex("c"), proof: hex("9") },
    address: alice.publicKey(),
    passkeyProof: hex("9"),
    accountProof: accountProof(alice),
  });
  ok(
    "alice connects a passkey through the front door",
    attach.status === 200 && attach.json.ok === true,
    JSON.stringify(attach.json).slice(0, 80),
  );

  const check = await call("POST", "/identity-check", { proof: { kind: "passkey", id: hex("c"), proof: hex("9") } });
  ok("checking it reports connected", check.status === 200 && check.json.taken === true);
  ok("and names the account by handle", check.json.handle === "meric", String(check.json.handle));

  // Bob signs for his OWN account, so this gets past the authorization gate and reaches the case
  // that matters: an identity already leading somewhere is not re-pointed. `conflict.handle` is
  // what the screen turns into "that already opens @meric", so a refusal that dropped it would
  // leave the user a blank failure.
  const steal = await call("POST", "/identity-attach", {
    proof: { kind: "passkey", id: hex("c"), proof: hex("9") },
    address: bob.publicKey(),
    accountProof: accountProof(bob),
  });
  ok("bob cannot re-point it at himself", steal.status === 409, String(steal.json.error));
  ok(
    "and the refusal carries the name the UI shows",
    (steal.json.conflict as { handle?: string } | undefined)?.handle === "meric",
    JSON.stringify(steal.json.conflict),
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

  /* One email, one account, in BOTH registries. An email that backs up one account must not become
     a way back in to another, or "find my account" and "restore my backup" open two different keys
     for the same address. And holding an inbox for one code is not standing to cut a way back in
     off the account it leads to: that account signs, as it does to attach one. */
  console.log("\n[6] one email, one account: the ways back in agree with the backups");
  const carol = Keypair.random();
  const BACKED = "backed-up@example.test";
  const backedId = await idForEmail(BACKED);
  const stored = await call("POST", "/recovery", { id: backedId, box: BOX, code: await codeFor(BACKED), owner: writeProof(carol, backedId) });
  ok("carol's backup of an email is bound to her account", stored.status === 200 && stored.json.bound === true, JSON.stringify(stored.json));
  const emailProof = async (email: string) => ({ kind: "email", email, code: await codeFor(email) });
  const refusedAttach = await call("POST", "/identity-attach", {
    proof: await emailProof(BACKED),
    address: alice.publicKey(),
    accountProof: accountProof(alice),
  });
  ok(
    "alice cannot make that email a way back in to HER account (409)",
    refusedAttach.status === 409 && refusedAttach.json.error === "That email already backs up another account.",
    `${refusedAttach.status} ${String(refusedAttach.json.error)}`,
  );
  const notAttached = await call("POST", "/identity-check", { proof: await emailProof(BACKED) });
  ok("and nothing was attached", notAttached.status === 200 && notAttached.json.taken === false);
  const ownAttach = await call("POST", "/identity-attach", {
    proof: await emailProof(BACKED),
    address: carol.publicKey(),
    accountProof: accountProof(carol),
  });
  ok("carol can attach it: the backup is her own account's", ownAttach.status === 200 && ownAttach.json.ok === true, JSON.stringify(ownAttach.json).slice(0, 80));
  const FRESH = "no-backup@example.test";
  const freshAttach = await call("POST", "/identity-attach", {
    proof: await emailProof(FRESH),
    address: alice.publicKey(),
    accountProof: accountProof(alice),
  });
  ok("an email with no backup row can be attached", freshAttach.status === 200 && freshAttach.json.ok === true, JSON.stringify(freshAttach.json).slice(0, 80));

  const codeOnly = await call("POST", "/identity-detach", { proof: await emailProof(FRESH) });
  ok(
    "detaching with the inbox code alone is refused (401)",
    codeOnly.status === 401 && codeOnly.json.error === "That account has to authorize this.",
    `${codeOnly.status} ${String(codeOnly.json.error)}`,
  );
  const stillLinked = await call("POST", "/identity-check", { proof: await emailProof(FRESH) });
  ok("and the email still leads to alice", stillLinked.json.taken === true && stillLinked.json.address === alice.publicKey());
  const freshId = await identityId("email", FRESH);
  const bobSigns = await call("POST", "/identity-detach", { proof: await emailProof(FRESH), accountProof: detachProof(bob, freshId) });
  ok("another account's signature does not authorize it either (401)", bobSigns.status === 401);
  const detached = await call("POST", "/identity-detach", { proof: await emailProof(FRESH), accountProof: detachProof(alice, freshId) });
  ok("the account's own signature over detach:<id> disconnects it", detached.status === 200 && detached.json.ok === true, JSON.stringify(detached.json));
  const unlinked = await call("POST", "/identity-check", { proof: await emailProof(FRESH) });
  ok("and the email leads nowhere now", unlinked.status === 200 && unlinked.json.taken === false);

  /* ------------------------- lookups: metered, validated, cached ------------------------- */
  console.log("\n[lookups] GET /handle, /handle-of and /federation are metered, judged before the store, and cached");
  {
    const from = (ip: string, path: string) => worker.fetch(new Request(`${BASE}${path}`, { headers: { "cf-connecting-ip": ip } }), ENV);
    resetLookupCache();
    const first = await call("GET", "/handle?name=meric");
    const second = await call("GET", "/handle?name=meric");
    const stats = lookupCacheStatsForTests();
    ok("two lookups of one name inside the window: one store read, one cache hit", stats.misses === 1 && stats.hits === 1, JSON.stringify(stats));
    ok("and the cached answer is the same answer", first.status === second.status && JSON.stringify(first.json) === JSON.stringify(second.json));
    const cem = Keypair.random();
    const before = await call("GET", "/handle?name=zeynep");
    const written = await call("POST", "/handle-claim", signed(cem, "claim", "zeynep"));
    const after = await call("GET", "/handle?name=zeynep");
    ok(
      "a name write drops the cache: the lookup right after it sees the new name",
      before.status === 404 && written.status === 200 && after.status === 200 && after.json.address === cem.publicKey(),
      `${before.status} ${written.status} ${after.status}`,
    );
    const badOf = await call("GET", "/handle-of?pubkey=not-a-key");
    ok("/handle-of with a malformed pubkey is 400 before any store read", badOf.status === 400);
    const badShape = await call("GET", "/handle?name=supp0rt");
    ok("/handle with a reserved lookalike answers from the shape alone", badShape.status === 404 && badShape.json.available === false && /reserved/.test(String(badShape.json.error)));
    const badFed = await call("GET", "/federation?q=%2A&type=name");
    ok("/federation with a malformed address is the SEP-0002 404 detail", badFed.status === 404 && badFed.json.detail === "invalid federation address");
    const badFedId = await call("GET", "/federation?q=junk&type=id");
    ok("/federation type=id with a malformed account is not found, read nowhere", badFedId.status === 404 && badFedId.json.detail === "not found");
    const badType = await call("GET", "/federation?q=x&type=txid");
    ok("/federation with an unsupported type says so", badType.status === 404 && /unsupported/.test(String(badType.json.detail)));
    const provider = OAUTH_PROVIDERS[0]!;
    const badState = await worker.fetch(new Request(`${BASE}/oauth/${provider}/callback?code=abc&state=not-hex`), ENV);
    ok("the OAuth callback with a malformed state is 400 before the store", badState.status === 400);
    const noCode = await worker.fetch(new Request(`${BASE}/oauth/${provider}/callback?state=${"a".repeat(32)}`), ENV);
    ok("and with no code", noCode.status === 400);
    const badProvider = await worker.fetch(new Request(`${BASE}/oauth/nobody/callback?code=abc&state=${"a".repeat(32)}`), ENV);
    ok("and for an unknown provider", badProvider.status === 400);

    // The limiter: its own bucket (`lookup:`), so a lookup storm never spends a value window and a
    // value window never refuses a lookup.
    const savedCap = process.env.RATE_CAP;
    process.env.RATE_CAP = "3";
    const statuses: number[] = [];
    try {
      for (let i = 0; i < 4; i++) statuses.push((await from("198.51.100.42", "/handle?name=meric")).status);
    } finally {
      if (savedCap === undefined) delete process.env.RATE_CAP;
      else process.env.RATE_CAP = savedCap;
    }
    ok("the fourth lookup from one address inside a 3-a-window cap is 429", statuses.slice(0, 3).every((s) => s !== 429) && statuses[3] === 429, statuses.join(","));
    const otherBucket = await worker.fetch(
      new Request(`${BASE}/handle-claim`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.42" },
        body: JSON.stringify({ ...signed(Keypair.random(), "claim", "nobody1"), proof: "bad" }),
      }),
      ENV,
    );
    ok("and the same address's name WRITE is in another bucket (refused for its proof, not throttled)", otherBucket.status === 409, String(otherBucket.status));
  }

  /* ------------------------- keys: judged before they key anything ------------------------- */
  console.log("\n[keys] a malformed account key is 400 before it becomes a limiter bucket, a pilot slot or a store key");
  {
    const huge = "G" + "A".repeat(10_000);
    const claimJunk = await call("POST", "/handle-claim", { ...signed(alice, "claim", "x"), pubkey: huge });
    ok("/handle-claim with a 10 KB pubkey is 400", claimJunk.status === 400, String(claimJunk.json.error));
    ok("/handle-release too", (await call("POST", "/handle-release", { name: "x", pubkey: "junk", ts: 1, nonce: "n", proof: "p" })).status === 400);
    ok("/identity-links with a junk pubkey is 400", (await call("POST", "/identity-links", { pubkey: "junk", ts: 1, nonce: "n", proof: "p" })).status === 400);
    ok("/identity-detach-mine too", (await call("POST", "/identity-detach-mine", { pubkey: "junk", provider: "email", ts: 1, nonce: "n", proof: "p" })).status === 400);
    ok("/recovery-alias-fetch with a junk id is 400", (await call("POST", "/recovery-alias-fetch", { id: "junk" })).status === 400);
    const valueRoutes: Array<[string, Record<string, unknown>]> = [
      ["/create-account", { recipientPublicKey: huge }],
      ["/feebump", { xdr: "AAAA", recipientPublicKey: huge, balanceId: "00" }],
      ["/send-link", { xdr: "AAAA", senderPublicKey: huge }],
      ["/payout", { xdr: "AAAA", senderPublicKey: huge, destination: alice.publicKey(), amount: "1" }],
      ["/sweep", { xdr: "AAAA", throwawayPublicKey: huge, homePublicKey: alice.publicKey(), amount: "1" }],
      ["/v2-claim", { method: "claim", linkHex: "ab".repeat(32), payout: huge, sigHex: "cd".repeat(64) }],
      ["/v2-deposit", { xdr: "AAAA", senderPublicKey: huge }],
      ["/v2-reclaim", { xdr: "AAAA", senderPublicKey: huge }],
    ];
    for (const [route, body] of valueRoutes) {
      const r = await call("POST", route, body);
      ok(`${route} with a 10 KB key is 400 naming the field`, r.status === 400 && /must be (a )?G/.test(String(r.json.error)), `${r.status} ${String(r.json.error).slice(0, 60)}`);
    }
    const contractPayout = await call("POST", "/v2-claim", {
      method: "claim",
      linkHex: "ab".repeat(32),
      payout: "CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3",
      sigHex: "cd".repeat(64),
    });
    ok("/v2-claim still takes a C... contract as the payout (refused later, not for its shape)", contractPayout.status !== 400 || !/must be a G/.test(String(contractPayout.json.error)), `${contractPayout.status} ${String(contractPayout.json.error).slice(0, 60)}`);
  }

  /* ------------------------- mail: budgeted, and never a silent 200 ------------------------- */
  console.log("\n[mail] mail is budgeted per day, per route and per inbox, and a refusal from Resend is not a 200");
  {
    const realFetch = globalThis.fetch;
    const resend = { calls: 0, refuse: false };
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (u.startsWith("https://api.resend.com/")) {
        resend.calls++;
        return new Response(JSON.stringify(resend.refuse ? { message: "rate limited" } : { id: "mail_1" }), {
          status: resend.refuse ? 429 : 200,
          headers: { "content-type": "application/json" },
        });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const names = ["RESEND_API_KEY", "OWNER_EMAIL", "FEEDBACK_NOTIFY_TO", "MAIL_DAY_CAP_TARGET", "MAIL_DAY_CAP_RECOVERY_OTP", "MAIL_DAY_CAP_FEEDBACK", "MAIL_DAY_CAP_PILOT_REQUEST"] as const;
    const savedEnv = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    process.env.RESEND_API_KEY = "re_test_never_sent";
    process.env.OWNER_EMAIL = "owner@example.com";
    process.env.FEEDBACK_NOTIFY_TO = "owner@example.com";
    process.env.MAIL_DAY_CAP_TARGET = "2";
    process.env.MAIL_DAY_CAP_RECOVERY_OTP = "5";
    process.env.MAIL_DAY_CAP_FEEDBACK = "1";
    process.env.MAIL_DAY_CAP_PILOT_REQUEST = "1";
    __resetMailBudgetForTests();
    try {
      const victim = "victim@example.com";
      const r1 = await call("POST", "/recovery-otp", { email: victim });
      const r2 = await call("POST", "/recovery-otp", { email: "  Victim@Example.com " });
      const r3 = await call("POST", "/recovery-otp", { email: victim });
      ok("two codes to one inbox go out (the address is normalized before it is counted)", r1.status === 200 && r2.status === 200 && resend.calls === 2, `${r1.status} ${r2.status} ${resend.calls}`);
      ok("the third is 429 with the mail-budget code, and no mail", r3.status === 429 && r3.json.code === "mail-budget" && resend.calls === 2, `${r3.status} ${JSON.stringify(r3.json)}`);
      const other = await call("POST", "/recovery-otp", { email: "other@example.com" });
      ok("another inbox is still served (the route's share is not spent)", other.status === 200 && resend.calls === 3, `${other.status} ${resend.calls}`);
      resend.refuse = true;
      const refused = await call("POST", "/recovery-otp", { email: "third@example.com" });
      ok("a code Resend refuses is 503 with the mail-unavailable code, never a 200", refused.status === 503 && refused.json.code === "mail-unavailable", `${refused.status} ${JSON.stringify(refused.json)}`);
      resend.refuse = false;

      /* The owner-notification routes: the record is kept and the route answers as it always did;
       * the budget decides only whether the mail is SENT, and a skipped or refused mail is one log
       * line (the counter of calls that reached the Resend stub is what shows it). */
      const quietly = async <T,>(run: () => Promise<T>): Promise<{ result: T; lines: string[] }> => {
        const lines: string[] = [];
        const real = console.log;
        console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
        try {
          return { result: await run(), lines };
        } finally {
          console.log = real;
        }
      };
      __resetMailBudgetForTests();
      resend.calls = 0;
      const f1 = await call("POST", "/feedback", { category: "site", message: "the button is blue" });
      const f2 = await quietly(() => call("POST", "/feedback", { category: "site", message: "the button is still blue" }));
      ok(
        "one report mails the owner; the route's second of the day is still 200 and stored, and mails nothing",
        f1.status === 200 && f2.result.status === 200 && resend.calls === 1 && f2.lines.some((l) => /^\[feedback:notify\] not mailed: the day's route mail budget is spent/.test(l)),
        `${f1.status} ${f2.result.status} ${resend.calls} | ${f2.lines.join(" | ")}`,
      );
      __resetMailBudgetForTests();
      resend.refuse = true;
      const f3 = await quietly(() => call("POST", "/feedback", { category: "site", message: "the owner reads the list for this one" }));
      ok(
        "a report Resend refuses is still stored and 200; the refusal is one log line with the status",
        f3.result.status === 200 && f3.lines.filter((l) => l.startsWith("[feedback:notify]")).length === 1 && f3.lines.some((l) => /resend returned 429/.test(l)),
        `${f3.result.status} | ${f3.lines.join(" | ")}`,
      );
      resend.refuse = false;

      __resetMailBudgetForTests();
      resend.calls = 0;
      const p1 = await call("POST", "/pilot-request", { pubkey: Keypair.random().publicKey(), email: "ask1@example.com" });
      const w2 = Keypair.random().publicKey();
      const p2 = await quietly(() => call("POST", "/pilot-request", { pubkey: w2, email: "ask2@example.com" }));
      const p2lines = p2.lines.filter((l) => l.startsWith("[pilot:request]"));
      ok(
        "the first pilot ask mails the owner; the route's second of the day is filed and 200 with no mail",
        p1.status === 200 && p2.result.status === 200 && p2.result.json.ok === true && resend.calls === 1,
        `${p1.status} ${p2.result.status} ${resend.calls}`,
      );
      ok(
        "and exactly one log line names the wallet, the contact and the budget",
        p2lines.length === 1 && p2lines[0] === `[pilot:request] testnet wallet ${w2} ask2@example.com (not mailed: the day's route mail budget is spent)`,
        p2lines.join(" | "),
      );
      __resetMailBudgetForTests();
      resend.refuse = true;
      const w3 = Keypair.random().publicKey();
      const p3 = await quietly(() => call("POST", "/pilot-request", { pubkey: w3, email: "ask3@example.com" }));
      const p3lines = p3.lines.filter((l) => l.startsWith("[pilot:request]"));
      ok(
        "a pilot ask whose owner mail Resend refuses is still filed and 200, with the one '(mail failed)' line",
        p3.result.status === 200 && p3lines.length === 1 && p3lines[0] === `[pilot:request] testnet wallet ${w3} ask3@example.com (mail failed)`,
        `${p3.result.status} | ${p3lines.join(" | ")}`,
      );
      resend.refuse = false;

      __resetMailBudgetForTests();
      resend.calls = 0;
      process.env.MAIL_DAY_CAP_FEEDBACK = "5";
      process.env.MAIL_DAY_CAP_PILOT_REQUEST = "5";
      const a = await call("POST", "/feedback", { category: "site", message: "one" });
      const b = await call("POST", "/pilot-request", { pubkey: Keypair.random().publicKey(), email: "ask4@example.com" });
      const c = await quietly(() => call("POST", "/feedback", { category: "site", message: "three" }));
      ok(
        "the owner's inbox is one budget across routes: a report and a pilot ask spend it, the third notification is skipped",
        a.status === 200 && b.status === 200 && c.result.status === 200 && resend.calls === 2 && c.lines.some((l) => /target mail budget is spent/.test(l)),
        `${a.status} ${b.status} ${c.result.status} ${resend.calls}`,
      );
    } finally {
      globalThis.fetch = realFetch;
      __resetMailBudgetForTests();
      for (const n of names) {
        const v = savedEnv[n];
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} IDENTITY ROUTE TESTS ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("\n💥 identity route test crashed:", e);
  process.exit(1);
});
