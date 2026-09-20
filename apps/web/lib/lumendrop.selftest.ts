/**
 * Group-link self-test - the pure decisions behind a link that holds a pot of shares
 * (lib/lumendrop.ts). No network, no keys, no escrow: everything here is a function of its inputs.
 *
 * Why these four, and not the happy path: each one is a place where a plausible line of code tells a
 * room of people something the ledger never said.
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
 *
 * RUN: pnpm --filter @lumenia/web exec tsx lib/lumendrop.selftest.ts   (offline, no keys, no network)
 */
import { Keypair } from "@stellar/stellar-sdk";
import {
  groupTotal,
  isTerminalClaimOutcome,
  MAX_POOL_SLOTS,
  MIN_POOL_SLOTS,
  parseSlots,
  poolStatusOf,
  resumeDecision,
  splitGroupHint,
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

function main() {
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
  ok("emptied and past the deadline → closed, NOT full", reclaimed === "closed" && reclaimed !== "full");

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

  console.log(`\n${failed === 0 ? "✅" : "❌"} GROUP-LINK SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

main();
