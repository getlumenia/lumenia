/**
 * Group-link self-test - the pure decisions behind a link that holds a pot of shares
 * (lib/lumendrop.ts). No network, no keys, no escrow: everything here is a function of its inputs.
 *
 * Why these five, and not the happy path: each one is a place where a plausible line of code tells a
 * room of people something the ledger never said, or hands a key parser something that is not a key.
 *
 *   - the `g` hint. It rides in a query anyone can rewrite, and a clamped or float-parsed value
 *     would print a share count the escrow never agreed to.
 *   - the pot. The contract floor-divides `amount / slots`, so a pot that is not an exact multiple
 *     of the share strands dust nobody can claim until the sender takes it back.
 *   - the pool's state. `reclaim_pool` sets remaining = 0 AND claimed = slots together, so a pool the
 *     sender emptied reads with every slot marked taken. Any count derived from a total minus
 *     `remaining` reports a take-back as a full payout - and the deployed Pool struct carries no
 *     total to derive it from in the first place.
 *   - what a phone that already asked may say. "You already took your share, it's in your account on
 *     this phone" is unfalsifiable to the person reading it, so it may only be printed after
 *     somebody looked, and never off a read that failed.
 *   - what rides behind the key. A private link carries the sender's name and the lock marker after
 *     the '#', and a reader that does not split them off hands lib/claim-password.ts `S...&s=Ayse`,
 *     which is a bad secret: every private link would fail to open.
 *   - a claim the relayer stopped watching (its 202): settled from the claim transaction and the
 *     payout account on a fake clock, never from the escrow's `claimed` flag, which a take-back sets
 *     too; and claimV2 itself, with the RPC and the sponsor faked, hands the 202 back as
 *     confirmed:false whatever body it carries.
 *
 * RUN: pnpm --filter @lumenia/web exec tsx lib/lumendrop.selftest.ts   (offline, no keys, no network)
 */
import { Account, Keypair, rpc, xdr } from "@stellar/stellar-sdk";
import { makeLinkSeed, parseLinkFragment, passwordFragment } from "./claim-password";
import { testnetConfig, type NetworkConfig } from "./network";
import {
  CLAIM_SETTLE,
  claimV2,
  readRelayReply,
  settleUnconfirmedClaim,
  type ClaimSettleReaders,
  groupTotal,
  isTerminalClaimOutcome,
  MAX_POOL_SLOTS,
  MIN_POOL_SLOTS,
  parseSlots,
  poolStatusOf,
  resumeDecision,
  splitGroupHint,
  v2LinkUrl,
  type ClaimLatch,
} from "./lumendrop";

let passed = 0;
let failed = 0;
function ok(label: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`  ✔ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
  }
}

/** USDC in integer stroops - the reference the exact-multiple cases are measured against. */
function stroops(dec: string): bigint {
  const [whole, frac = ""] = dec.trim().split(".");
  return BigInt(whole || "0") * 10_000_000n + BigInt(`${frac}0000000`.slice(0, 7));
}

/** The float multiplication this deliberately does not do. */
function floatTotal(perShare: string, slots: number): string {
  return (Number.parseFloat(perShare) * slots).toString();
}

const HOUR = 3600;
const now = 1_760_000_000; // a fixed "now" so nothing here depends on when it runs

async function main() {
  console.log("============================================================");
  console.log(" SELF-TEST - group links");
  console.log("============================================================\n");

  // --- the share count is a hint, and a hostile hint is ignored ----------------------------------
  console.log("[1] reading the `g` hint");
  ok('"6" reads as six shares', parseSlots("6") === 6);
  ok("  ...and the bounds are the relay's bounds", parseSlots(String(MIN_POOL_SLOTS)) === MIN_POOL_SLOTS && parseSlots(String(MAX_POOL_SLOTS)) === MAX_POOL_SLOTS);
  ok('"1" is ignored - a one-share pool is a single link with extra steps', parseSlots("1") === null);
  ok('"0" is ignored', parseSlots("0") === null);
  ok(`"${MAX_POOL_SLOTS + 1}" is ignored, not clamped to ${MAX_POOL_SLOTS}`, parseSlots(String(MAX_POOL_SLOTS + 1)) === null);
  ok("  ...because a clamped count would print a number the escrow never agreed to", parseSlots("999") === null);
  ok('"6.5" is ignored', parseSlots("6.5") === null);
  ok('"-3" is ignored', parseSlots("-3") === null);
  ok('"0x6" is not read as 6', parseSlots("0x6") === null);
  ok('"6e0" is not read as 6', parseSlots("6e0") === null);
  ok('"" is ignored', parseSlots("") === null);
  ok("a missing hint is ignored", parseSlots(undefined) === null && parseSlots(null) === null);
  ok("a repeated query param reads the first", parseSlots(["6", "30"]) === 6);
  ok("whitespace around it survives", parseSlots(" 6 ") === 6);

  // --- the count travels twice, because chat apps trim queries -----------------------------------
  // The fragment is the key. If the `g` copy is not split off before lib/claim-password.ts sees it,
  // every group link is a bad secret, so this is asserted against a REAL keypair rather than a
  // look-alike string.
  console.log("\n[2] the copy that rides in the #fragment");
  const kp = Keypair.random();
  const carried = splitGroupHint(`${kp.secret()}&g=6`);
  ok("the share count comes out of the fragment", carried.slots === 6);
  ok("  ...and the key comes out byte-identical", carried.fragment === kp.secret());
  ok("  ...and still opens the same link", Keypair.fromSecret(carried.fragment).publicKey() === kp.publicKey());

  const locked = splitGroupHint("p1.dGhpcy1pcy1ub3QtYS1yZWFsLXNlZWQ&g=3");
  ok("a password-locked fragment keeps its seed", locked.fragment === "p1.dGhpcy1pcy1ub3QtYS1yZWFsLXNlZWQ" && locked.slots === 3);

  const hashed = splitGroupHint(`#${kp.secret()}&g=4`);
  ok("a leading # is not part of the key", hashed.fragment === kp.secret() && hashed.slots === 4);

  const plain = splitGroupHint(kp.secret());
  ok("a single link's fragment is untouched", plain.fragment === kp.secret() && plain.slots === null);

  const nonsense = splitGroupHint(`${kp.secret()}&g=600`);
  ok("an out-of-bounds hint is dropped", nonsense.slots === null);
  ok("  ...and never becomes part of the key", nonsense.fragment === kp.secret());

  // --- the pot is an exact multiple of the share --------------------------------------------------
  console.log("\n[3] the pot the contract will floor-divide");
  ok('$2.50 x 6 is exactly $15', groupTotal("2.50", 6) === "15.0000000");
  ok("  ...and divides back to the share with nothing left over", stroops(groupTotal("2.50", 6)) / 6n === stroops("2.50") && stroops(groupTotal("2.50", 6)) % 6n === 0n);

  let exact = true;
  let dividesBack = true;
  for (const [perShare, slots] of [
    ["0.01", 30],
    ["0.07", 3],
    ["1", 2],
    ["3.33", 7],
    ["15", 6],
    ["0.03", 29],
  ] as [string, number][]) {
    const total = groupTotal(perShare, slots);
    if (stroops(total) !== stroops(perShare) * BigInt(slots)) exact = false;
    // What the contract does: amount / slots, floor. It must land back on the share exactly.
    if (stroops(total) / BigInt(slots) !== stroops(perShare)) dividesBack = false;
  }
  ok("every pot is the share times the count, in stroops", exact);
  ok("  ...so the contract's floor division strands no dust", dividesBack);
  ok('a float would have said $0.21000000000000002 for 0.07 x 3', floatTotal("0.07", 3) !== "0.21" && groupTotal("0.07", 3) === "0.2100000");

  // --- the four states a pool can be in ------------------------------------------------------------
  console.log("\n[4] what a pool can still do");
  const open = poolStatusOf({ remaining: stroops("10"), slots: 6, claimed: 2, expiry: now + HOUR }, now);
  ok("shares left, before the deadline → open", open === "open");

  const full = poolStatusOf({ remaining: 0n, slots: 6, claimed: 6, expiry: now + HOUR }, now);
  ok("every share taken, before the deadline → full", full === "full");

  const expired = poolStatusOf({ remaining: stroops("10"), slots: 6, claimed: 2, expiry: now - 1 }, now);
  ok("money still on it, past the deadline → expired (the sender can take it back)", expired === "expired");

  // THE TRAP. reclaim_pool sets remaining = 0 AND claimed = slots in the same write, so a pool the
  // sender emptied is indistinguishable from a fully-claimed one by the counter alone. It is its own
  // state, and the screens branch on it before they print any count.
  const reclaimed = poolStatusOf({ remaining: 0n, slots: 6, claimed: 6, expiry: now - 1 }, now);
  ok("emptied and past the deadline → closed, NOT full", reclaimed === "closed");

  // The count the screens render. Derived from `claimed`, because there is nothing else: the
  // deployed Pool struct has no `amount` field, so "total minus remaining" is not computable - and
  // substituting amount_per x slots reads one low for the pool's whole life whenever the pot carries
  // dust.
  const mid = { remaining: stroops("2.50") * 4n, slots: 6, claimed: 2, expiry: now + HOUR };
  ok("two taken out of six, read off `claimed`", mid.claimed === 2 && mid.slots - mid.claimed === 4);
  ok("  ...and the state agrees there is still something to take", poolStatusOf(mid, now) === "open");

  // The contract's own second guard: it refuses a share when `remaining < amount_per` even if the
  // counter disagrees. A pool that cannot pay another share is not open, whatever the counter says.
  const drained = poolStatusOf({ remaining: 0n, slots: 6, claimed: 3, expiry: now + HOUR }, now);
  ok("nothing left to pay a share with → not open", drained !== "open");

  // --- what a phone that already asked may say -----------------------------------------------------
  console.log("\n[5] the device latch, after looking");
  const latch: ClaimLatch = { state: "attempted", payout: Keypair.random().publicKey(), link: "group", at: now * 1000 };

  ok("no latch → say nothing, this is an ordinary first claim", resumeDecision({ latch: null, payoutUsd: "0", claimable: true }).say === "nothing");

  const looked = resumeDecision({ latch, payoutUsd: "2.5000000", claimable: null });
  ok("the money is in the account → say it is taken", looked.say === "taken");
  ok("  ...and say how much, from the read, not from the link", looked.say === "taken" && looked.usd === "2.5000000");
  ok("even a dust balance is money", resumeDecision({ latch, payoutUsd: "0.0000001", claimable: null }).say === "taken");

  ok("empty account, link can still pay → offer one resume", resumeDecision({ latch, payoutUsd: "0", claimable: true }).say === "resume");
  ok("empty account, link cannot pay → say it was missed", resumeDecision({ latch, payoutUsd: "0", claimable: false }).say === "missed");
  ok("empty account, link unreadable → say we are unsure", resumeDecision({ latch, payoutUsd: "0", claimable: null }).say === "unsure");

  // The rule this whole section exists for: a read that did not happen is not a zero, and it is
  // never grounds for telling somebody where their money is.
  const blind = [true, false, null].map((claimable) => resumeDecision({ latch, payoutUsd: null, claimable }));
  ok("a failed balance read never says anything about the money", blind.every((d) => d.say === "unsure"));
  ok("  ...and in particular never says it is taken", blind.every((d) => d.say !== "taken"));

  // --- a settled answer is a settled answer ----------------------------------------------------------
  console.log("\n[6] which outcomes end the story");
  ok("a paid claim is not a retry question", isTerminalClaimOutcome({ kind: "claimed", hash: "h", publicKey: "G", seed: new Uint8Array(0), link: "group" }) === false);
  const settled = (["already-yours", "already-claimed", "no-such-drop", "expired"] as const).map((kind) =>
    isTerminalClaimOutcome(kind === "already-yours" ? { kind, publicKey: "G", link: "group" } : { kind, link: "group" }),
  );
  ok("every settled answer is final - no tap changes it", settled.every(Boolean));

  // --- what rides behind the key in a private link ---------------------------------------------------
  // D2 moved the sender's name and the lock marker out of the query and in behind the key. Each has to
  // come off before lib/claim-password.ts sees the fragment or the link does not open, so this is
  // asserted, again, against a REAL keypair and a REAL p1. seed rather than look-alike strings.
  console.log("\n[7] the name and the lock marker that ride behind the key");
  const named = splitGroupHint(`${kp.secret()}&s=Ayse`);
  ok("the sender's name comes out of the fragment", named.from === "Ayse");
  ok("  ...and the key comes out byte-identical, and still opens the same link", named.fragment === kp.secret() && Keypair.fromSecret(named.fragment).publicKey() === kp.publicKey());
  ok("  ...with no share count and no lock", named.slots === null && named.passwordLocked === false);

  const seed = makeLinkSeed();
  const lockedPrivate = splitGroupHint(`#${passwordFragment(seed)}&s=Ayse&g=3&p=1`);
  ok(
    "a locked group link: the seed, the name, three shares and the lock all come apart",
    lockedPrivate.fragment === passwordFragment(seed) && lockedPrivate.from === "Ayse" && lockedPrivate.slots === 3 && lockedPrivate.passwordLocked,
  );
  const seedBack = parseLinkFragment(lockedPrivate.fragment);
  ok("  ...and the seed is still exactly the seed", seedBack?.kind === "password" && Buffer.from(seedBack.seed).equals(Buffer.from(seed)));

  const hostile = splitGroupHint(`${kp.secret()}&s=${encodeURIComponent("Ay&p=1#S")}`);
  ok('a name like "Ay&p=1#S" comes back as that literal name', hostile.from === "Ay&p=1#S");
  ok("  ...and locks nothing, and leaves the key untouched", hostile.passwordLocked === false && hostile.fragment === kp.secret());
  const smuggled = splitGroupHint(`${kp.secret()}&s=${encodeURIComponent("x&g=6")}`);
  ok('a name like "x&g=6" adds no share count', smuggled.slots === null && smuggled.from === "x&g=6");

  const reordered = splitGroupHint(`${kp.secret()}&p=1&g=6&s=Ayse&x=1`);
  ok(
    "the order behind the key does not matter, and an unknown parameter is ignored",
    reordered.fragment === kp.secret() && reordered.slots === 6 && reordered.passwordLocked && reordered.from === "Ayse",
  );
  const twice = splitGroupHint(`${kp.secret()}&s=Ayse&s=Mallory&p=0&p=1`);
  ok("the first of a repeated parameter wins", twice.from === "Ayse" && twice.passwordLocked === false);
  ok("a pre-D2 fragment (the key and the g copy) carries no name and no lock", carried.from === null && carried.passwordLocked === false);

  const linkHex = Buffer.from(kp.rawPublicKey()).toString("hex");
  const privateGroup = v2LinkUrl({ webOrigin: "https://getlumenia.com", linkHex, amount: "2.50", from: "Ayse", fragment: kp.secret(), slots: 6 });
  const readBack = splitGroupHint(new URL(privateGroup).hash);
  ok(
    "a private group link built by v2LinkUrl reads back: the key, six shares, the name, no lock",
    readBack.fragment === kp.secret() && readBack.slots === 6 && readBack.from === "Ayse" && !readBack.passwordLocked,
  );

  await unconfirmedClaims();

  console.log(`\n${failed === 0 ? "✅" : "❌"} GROUP-LINK SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

/* ------------------------- a claim the relayer stopped watching -------------------------
 * The relayer's 202 (confirmed:false) is settled by READING, and what it reads decides whether a
 * recipient is told "it's yours", "try again" or "check back". The escrow's `claimed` flag is not
 * among the readers on purpose: LumenDrop sets it on the sender's take-back and on a claim from
 * another device too, so a claim that FAILED behind a take-back read as landed. These pin each
 * verdict to the transaction and the payout account, on a fake clock. */
async function unconfirmedClaims(): Promise<void> {
  console.log("\n[7] a claim the relayer accepted and never saw decided (settleUnconfirmedClaim)");
  const HASH = "ab".repeat(32);
  const DEADLINE = CLAIM_SETTLE.timeboundMs + CLAIM_SETTLE.marginMs; // after the 202 arrived

  /** A ledger in a script: what getTransaction and the payout's balance say at each moment. */
  const ledger = (o: {
    tx?: (t: number) => { status: string } | "throw";
    payout?: (t: number) => bigint | null | "throw";
  }) => {
    let t = 0;
    let txReads = 0;
    const readers: ClaimSettleReaders = {
      transaction: async () => {
        txReads++;
        const a = (o.tx ?? (() => ({ status: "NOT_FOUND" })))(t);
        if (a === "throw") throw new Error("rpc unreachable");
        return a;
      },
      payoutStroops: async () => {
        const a = (o.payout ?? (() => 0n))(t);
        if (a === "throw") throw new Error("horizon unreachable");
        return a;
      },
      now: () => t,
      sleep: async (ms) => void (t += ms),
    };
    return { readers, clock: () => t, reads: () => txReads };
  };
  const settle = (l: ReturnType<typeof ledger>, hash = HASH) => settleUnconfirmedClaim(hash, l.readers, { acceptedAt: 0 });

  const success = ledger({ tx: () => ({ status: "SUCCESS" }) });
  ok("the claim transaction succeeded: claimed, at the first read", (await settle(success)) === "claimed" && success.clock() === 0);
  const refused = ledger({ tx: () => ({ status: "FAILED" }) });
  ok("the claim transaction FAILED (a take-back landed first, say): not-landed, never claimed", (await settle(refused)) === "not-landed");
  const late = ledger({ tx: (t) => (t >= 30_000 ? { status: "SUCCESS" } : { status: "NOT_FOUND" }) });
  ok("not found, then found successful 30 s later: claimed", (await settle(late)) === "claimed" && late.clock() === 30_000);

  const never = ledger({});
  const neverVerdict = await settle(never);
  ok(`never found: not-landed, but only once a read at or past the deadline says so (t=${never.clock()}, deadline=${DEADLINE})`, neverVerdict === "not-landed" && never.clock() >= DEADLINE);
  ok("  ...and not a read earlier: no verdict inside the 60 s time bound plus the margin", never.clock() - CLAIM_SETTLE.stepMs < DEADLINE);

  const arrived = ledger({ payout: (t) => (t >= 10_000 ? 50_000_000n : 0n) });
  ok("not found, but the payout account holds the money: claimed (the second signal)", (await settle(arrived)) === "claimed" && arrived.clock() === 10_000);
  const dark = ledger({ tx: () => "throw", payout: () => "throw" });
  ok("the RPC and Horizon both unreachable for the whole window: unknown, never not-landed", (await settle(dark)) === "unknown");
  const rpcDown = ledger({ tx: () => "throw", payout: (t) => (t >= 4_000 ? 1n : 0n) });
  ok("the RPC down, the money in the payout: claimed", (await settle(rpcDown)) === "claimed");
  const lastReadFailed = ledger({ tx: (t) => (t >= DEADLINE ? "throw" : { status: "NOT_FOUND" }) });
  ok("not found until the deadline, then the read at the deadline fails: unknown (no final answer)", (await settle(lastReadFailed)) === "unknown");
  const odd = ledger({ tx: () => ({ status: "PENDING" }) });
  ok("a status that is not one of the three is not an answer: unknown at the deadline", (await settle(odd)) === "unknown");
  const noHash = ledger({});
  ok("a 202 that named no hash can never be 'not-landed' (nothing to look for): unknown", (await settle(noHash, "")) === "unknown" && noHash.reads() === 0);
  const noHashPaid = ledger({ payout: () => 3n });
  ok("...but the payout's balance can still say claimed", (await settle(noHashPaid, "")) === "claimed");
  /* A RESUMED claim presents the latch's payout, which may be the home account other links' money
     was swept into: its balance says nothing about this claim, so the transaction alone decides. */
  const resumedHome = ledger({ payout: () => 80_000_000n });
  const resumed = await settleUnconfirmedClaim(HASH, resumedHome.readers, { acceptedAt: 0, useBalance: false });
  ok(`a resumed claim whose payout already holds money from elsewhere: not 'claimed' on the balance (the transaction decides; got ${resumed})`, resumed === "not-landed");
  const resumedLanded = ledger({ tx: (t) => (t >= 6_000 ? { status: "SUCCESS" } : { status: "NOT_FOUND" }), payout: () => 80_000_000n });
  ok("...and when its transaction does land, it is claimed", (await settleUnconfirmedClaim(HASH, resumedLanded.readers, { acceptedAt: 0, useBalance: false })) === "claimed");

  console.log("\n[8] what a relay's reply means (readRelayReply, claimV2)");
  ok("202 {hash, confirmed:false}: undecided, with the hash", readRelayReply(202, JSON.stringify({ hash: HASH, confirmed: false }))?.hash === HASH);
  ok("202 {error:'submit unconfirmed', hash}: undecided, with the hash", readRelayReply(202, JSON.stringify({ error: "submit unconfirmed", hash: HASH }))?.hash === HASH);
  ok("202 that is not JSON: undecided, no hash, no crash", readRelayReply(202, "<html>accepted</html>")?.hash === "");
  ok("200 {hash, confirmed:false}: undecided too (the body says so)", readRelayReply(200, JSON.stringify({ hash: HASH, confirmed: false }))?.confirmed === false);
  ok("200 {hash}: not undecided", readRelayReply(200, JSON.stringify({ hash: HASH })) === null);
  ok("400: not undecided (the caller throws its refusal)", readRelayReply(400, JSON.stringify({ error: "group-claim-failed: drop-empty" })) === null);
  ok("a hash that is not 64 hex is not carried", readRelayReply(202, JSON.stringify({ hash: "nope", confirmed: false }))?.hash === "");

  // claimV2 itself, with the RPC and the sponsor faked: the 202 reaches the caller as confirmed:false.
  const proto = rpc.Server.prototype as unknown as {
    getAccount: (id: string) => Promise<Account>;
    simulateTransaction: (tx: unknown) => Promise<unknown>;
  };
  const realGet = proto.getAccount;
  const realSim = proto.simulateTransaction;
  const realFetch = globalThis.fetch;
  proto.getAccount = async (id: string) => new Account(id, "1");
  proto.simulateTransaction = async () => ({ result: { auth: [], retval: xdr.ScVal.scvBytes(Buffer.from("claim message")) } });
  const NET: NetworkConfig = { ...testnetConfig(), legacyContracts: [] };
  const payout = Keypair.random().publicKey();
  const linkKey = Keypair.random();
  const answer = async (status: number, body: string) => {
    const posted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      posted.push(String(input));
      return new Response(body, { status });
    }) as typeof fetch;
    try {
      return { value: await claimV2({ linkSecret: linkKey.secret(), payout, sponsorUrl: "https://sponsor.invalid", net: NET }), posted };
    } catch (e) {
      return { error: e as Error, posted };
    }
  };
  try {
    const r202 = await answer(202, JSON.stringify({ hash: HASH, confirmed: false }));
    ok("claimV2: a 202 is {hash, confirmed:false}, not a throw", "value" in r202 && r202.value?.confirmed === false && r202.value.hash === HASH);
    ok("  ...posted once, to /v2-claim", r202.posted.length === 1 && r202.posted[0]!.endsWith("/v2-claim"));
    const rSaid = await answer(202, JSON.stringify({ error: "submit unconfirmed", hash: HASH }));
    ok("claimV2: the relay's 'submit unconfirmed' 202 is confirmed:false too", "value" in rSaid && rSaid.value?.confirmed === false && rSaid.value.hash === HASH);
    const rJunk = await answer(202, "accepted");
    ok("claimV2: a 202 that is not JSON is still confirmed:false, and does not crash", "value" in rJunk && rJunk.value?.confirmed === false && rJunk.value.hash === "");
    const r200 = await answer(200, JSON.stringify({ hash: HASH }));
    ok("claimV2: a 200 is confirmed", "value" in r200 && r200.value?.confirmed === true);
    const r400 = await answer(400, JSON.stringify({ error: "group-claim-failed: drop-empty" }));
    ok("claimV2: a 400 is thrown with its body, for the classifier", "error" in r400 && /v2-claim .* 400: .*drop-empty/.test(r400.error!.message));
  } finally {
    proto.getAccount = realGet;
    proto.simulateTransaction = realSim;
    globalThis.fetch = realFetch;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
