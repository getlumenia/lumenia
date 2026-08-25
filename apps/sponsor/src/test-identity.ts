/**
 * ============================================================================
 *  TEST — names (@handle) + ways back in (identity links)
 * ============================================================================
 *
 *  Two registries, one property worth protecting each:
 *
 *  NAMES. A name on a payment surface is a target for impersonation, not just squatting. The
 *  checks below pin the three things that stop `@mer1c` from being paid money meant for `@meric`:
 *  the confusable skeleton is what is reserved, a claim is an Ed25519 signature from the account
 *  itself, and a released name is tombstoned rather than freed.
 *
 *  WAYS BACK IN. A linked identity must never become a way to open the money, and a lookup must
 *  never become an oracle that tells a stranger which emails have accounts. So: attach refuses to
 *  re-point an identity that already leads somewhere else (and says where, by name), a passkey row
 *  is bound to its PRF proof on first write, and nothing is answered without a proof.
 *
 *  Everything runs against the in-memory store fallback — no network, no keys, no KV.
 *
 *  RUN: pnpm --filter @lumenia/sponsor test:identity
 * ============================================================================
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  claimHandle,
  releaseHandle,
  lookupHandle,
  handleOf,
  federationLookup,
  handleProofMessage,
  proofNonce,
  normalizeHandle,
  validateHandleShape,
  skeleton,
  verifyHandleProof,
  __resetHandleStore,
  type ProofAction,
} from "./lib/handles.js";
import {
  identityId,
  resolveProof,
  checkIdentity,
  attachIdentity,
  fetchByIdentity,
  detachIdentity,
  listLinks,
  availableOAuthProviders,
  __resetIdentityStore,
} from "./lib/identity-links.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}

const NET = "testnet" as const;
const alice = Keypair.random();
const bob = Keypair.random();

/** Sign the exact message the server will rebuild. `ts` is a parameter so expiry can be tested. */
function proofFor(
  kp: Keypair,
  action: ProofAction,
  name: string,
  ts = Math.floor(Date.now() / 1000),
  nonce = proofNonce(),
) {
  const message = handleProofMessage(action, name, kp.publicKey(), ts, nonce, NET);
  return {
    action,
    name,
    pubkey: kp.publicKey(),
    ts,
    nonce,
    network: NET,
    proof: kp.sign(Buffer.from(message, "utf8")).toString("base64"),
  };
}

const BOX = {
  formatVersion: 1,
  copies: [{ kind: "password", iv: "AAAA", ct: "BBBB", salt: "CCCC", argon: { memMiB: 48, time: 2, parallelism: 1 } }],
};
const hex = (c: string) => c.repeat(64);

async function main(): Promise<void> {
  console.log("============================================================");
  console.log(" IDENTITY TESTS — names + ways back in (offline)");
  console.log("============================================================\n");

  /* ------------------------------- name shape ------------------------------- */
  console.log("[1] what a name may be");
  ok("strips a leading @ and lowercases", normalizeHandle("  @MeRiC ") === "meric");
  ok("accepts a plain name", validateHandleShape("meric").ok === true);
  ok("rejects two characters", validateHandleShape("me").ok !== true);
  ok("rejects a leading digit", validateHandleShape("1meric").ok !== true);
  ok("rejects punctuation", validateHandleShape("me.ric").ok !== true);
  ok("rejects 21 characters", validateHandleShape("a".repeat(21)).ok !== true);
  ok("refuses a reserved word", validateHandleShape("support").ok !== true);
  ok("refuses a reserved word in disguise", validateHandleShape("supp0rt").ok !== true, "skeleton folds 0→o");

  console.log("\n[2] confusable folding — the impersonation guard");
  ok("digits fold to letters", skeleton("mer1c") === skeleton("meric"));
  ok("underscores vanish", skeleton("me_ric") === skeleton("meric"));
  ok("rn folds to m", skeleton("rnark") === skeleton("mark"));
  ok("distinct names stay distinct", skeleton("meric") !== skeleton("deniz"));

  /* -------------------------------- claiming -------------------------------- */
  console.log("\n[3] claiming a name is a signature, not a session");
  __resetHandleStore();
  const claimed = await claimHandle(proofFor(alice, "claim", "meric"));
  ok("alice claims @meric", claimed.ok === true);
  ok("the registry answers", (await lookupHandle("meric"))?.pubkey === alice.publicKey());
  ok("the reverse answers", (await handleOf(alice.publicKey(), NET)) === "meric");

  const forged = proofFor(alice, "claim", "deniz");
  forged.pubkey = bob.publicKey(); // alice's signature, bob's name on the request
  ok("a signature from another account is refused", (await claimHandle(forged)).ok !== true);

  const stale = await claimHandle(proofFor(bob, "claim", "deniz", Math.floor(Date.now() / 1000) - 4000));
  ok("an expired proof is refused", stale.ok !== true);

  const replayed = proofFor(bob, "claim", "deniz");
  ok("a fresh proof works once", (await claimHandle(replayed)).ok === true);
  // Re-sending the identical signed request must not be honoured a second time. Bob already holds
  // @deniz, so the refusal we are pinning is the replay guard, checked before ownership.
  const again = await verifyHandleProof(replayed);
  ok("the same proof cannot be replayed", again.ok !== true);

  console.log("\n[4] a name is taken once, and lookalikes are taken with it");
  ok("a taken name is refused", (await claimHandle(proofFor(bob, "claim", "meric"))).ok !== true);
  ok("re-claiming your own name is a no-op success", (await claimHandle(proofFor(alice, "claim", "meric"))).ok === true);
  const lookalike = await claimHandle(proofFor(bob, "claim", "mer1c"));
  ok("a lookalike is refused", lookalike.ok !== true, lookalike.ok !== true ? lookalike.reason : "");
  ok("@mer1c did not get stored", (await lookupHandle("mer1c")) === null);
  const second = await claimHandle(proofFor(alice, "claim", "kaan"));
  ok("one account may hold only one name", second.ok !== true);

  console.log("\n[5] giving a name up does not hand it to the next person");
  ok("a stranger cannot release it", (await releaseHandle(proofFor(bob, "release", "meric"))).ok !== true);
  ok("the owner can", (await releaseHandle(proofFor(alice, "release", "meric"))).ok === true);
  ok("it stops resolving", (await lookupHandle("meric")) === null);
  ok("the reverse pointer is gone", (await handleOf(alice.publicKey(), NET)) === null);
  const grab = await claimHandle(proofFor(bob, "claim", "meric"));
  ok("nobody may re-register it during the cooldown", grab.ok !== true, grab.ok !== true ? grab.reason : "");
  const lookalikeAfter = await claimHandle(proofFor(bob, "claim", "mer1c"));
  ok("nor may a lookalike move in", lookalikeAfter.ok !== true);

  /* ------------------------------- federation ------------------------------- */
  console.log("\n[6] SEP-0002 federation");
  __resetHandleStore();
  await claimHandle(proofFor(alice, "claim", "meric"));
  process.env.FEDERATION_DOMAIN = "getlumenia.com";
  const byName = await federationLookup("meric*getlumenia.com", "name", NET);
  ok("name → account", "account_id" in byName && byName.account_id === alice.publicKey());
  const byId = await federationLookup(alice.publicKey(), "id", NET);
  ok("account → name", "stellar_address" in byId && byId.stellar_address === "meric*getlumenia.com");
  ok("another domain is refused", "ok" in (await federationLookup("meric*example.com", "name", NET)));
  ok("an unknown name 404s", "ok" in (await federationLookup("nobody*getlumenia.com", "name", NET)));
  ok("txid is refused rather than guessed", "ok" in (await federationLookup("x", "txid", NET)));
  // A name is global across networks; an INSTRUCTION TO PAY is not. Answering a mainnet lookup with
  // a testnet account id would send real money at an account that does not exist on that chain.
  ok(
    "a name held on another network is not answered here",
    "ok" in (await federationLookup("meric*getlumenia.com", "name", "mainnet")),
  );

  /* ----------------------------- ways back in ------------------------------- */
  console.log("\n[7] identity ids are domain-separated");
  __resetIdentityStore();
  const emailId = await identityId("email", "  Meric@Example.com ");
  ok("email ids normalize", emailId === (await identityId("email", "meric@example.com")));
  ok("the same string under two providers differs", emailId !== (await identityId("google", "meric@example.com")));
  ok("a passkey id is used as-is", (await identityId("passkey", hex("a"))) === hex("a"));

  console.log("\n[8] nothing is answered without a proof");
  const noProof = await resolveProof({ kind: "email", email: "meric@example.com", code: "000000" }, {
    verifyEmailOtp: async () => false,
  });
  ok("a wrong code proves nothing", noProof === null);
  const goodEmail = await resolveProof({ kind: "email", email: "meric@example.com", code: "123456" }, {
    verifyEmailOtp: async () => true,
  });
  ok("a right code resolves the identity", goodEmail?.provider === "email");
  ok("an unknown ticket proves nothing", (await resolveProof({ kind: "ticket", ticket: hex("f").slice(0, 48) }, { verifyEmailOtp: async () => true })) === null);

  console.log("\n[9] connecting, and the warning that makes it useful");
  const emailIdentity = goodEmail!;
  ok("nothing is connected yet", (await checkIdentity(emailIdentity, NET)).taken === false);
  const attached = await attachIdentity(emailIdentity, alice.publicKey(), NET, BOX);
  ok("alice connects her email", attached.ok === true);
  const check = await checkIdentity(emailIdentity, NET);
  ok("it now reports as connected", check.taken === true);
  ok("and names the account it opens", check.handle === "meric", check.handle ?? "no handle");
  const stolen = await attachIdentity(emailIdentity, bob.publicKey(), NET, BOX);
  ok("it refuses to re-point at another account", stolen.ok === false);
  ok("and the refusal carries the name", stolen.ok === false && stolen.conflict?.handle === "meric");
  ok("alice's own re-attach still works", (await attachIdentity(emailIdentity, alice.publicKey(), NET, BOX)).ok === true);

  console.log("\n[10] a passkey row is bound to its own PRF proof");
  const passkeyProof = { kind: "passkey" as const, id: hex("c"), proof: hex("9") };
  const pk = await resolveProof(passkeyProof, { verifyEmailOtp: async () => false });
  ok("an unclaimed passkey id resolves", pk?.provider === "passkey");
  await attachIdentity(pk!, alice.publicKey(), NET, BOX, passkeyProof.proof);
  const impostor = await resolveProof({ kind: "passkey", id: hex("c"), proof: hex("8") }, { verifyEmailOtp: async () => false });
  ok("a different proof for the same id is refused", impostor === null);
  const rightful = await resolveProof(passkeyProof, { verifyEmailOtp: async () => false });
  ok("the original proof still works", rightful !== null);

  console.log("\n[11] fetching, listing and disconnecting");
  const found = await fetchByIdentity(emailIdentity);
  ok("the box comes back to a proved identity", found?.box !== undefined);
  ok("along with the account it belongs to", found?.address === alice.publicKey());
  const links = await listLinks(alice.publicKey(), NET);
  ok("the account lists both connections", links.length === 2, links.map((l) => l.provider).join("+"));
  ok("a listing never leaks the ids", !JSON.stringify(links).includes(hex("c")));
  ok("disconnecting works", (await detachIdentity(emailIdentity)).ok === true);
  ok("and it stops resolving", (await fetchByIdentity(emailIdentity)) === null);
  ok("the other connection survives", (await listLinks(alice.publicKey(), NET)).length === 1);
  ok("disconnecting twice is an honest refusal", (await detachIdentity(emailIdentity)).ok === false);

  console.log("\n[12] unregistered providers are not offered");
  ok("no OAuth app configured → nothing offered", availableOAuthProviders().length === 0);

  console.log(`\n${failed === 0 ? "✅" : "❌"} IDENTITY TESTS ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main().catch((e) => {
  console.error("\n💥 identity test crashed:", e);
  process.exit(1);
});
