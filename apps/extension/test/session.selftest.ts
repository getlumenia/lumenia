/**
 * Session self-test: when the unlocked key may be used, and that a late alarm cannot change it.
 *
 *   [a] the pure reducer (src/lib/session.ts): unlock sets the deadline from the idle period, touch
 *       pushes it back only while the session is alive, an expired session is locked by touch or tick,
 *       `now === lockAt` is already locked, and canSign needs the same account before the deadline.
 *   [b] the wiring (src/background/account.ts) against a fake chrome and in-memory storage areas, with
 *       a real 32-byte seed in the session: signerFor hands out a signer for the right key only,
 *       checks the deadline itself (the seed can still be stored and the answer is still "locked"),
 *       and the refusal wipes the seed; lock() wipes exactly the session keys and clears the alarm;
 *       touch() and isUnlockedNow() act on the same rules.
 *
 * RUN: pnpm --filter @lumenia/extension test:session   (offline, no keys, no network)
 */
import { Keypair } from "@stellar/stellar-sdk";
import { LOCKED, canSign, isUnlocked, lockAtFor, reduce, type SessionEvent, type SessionView } from "../src/lib/session";
import { installChrome } from "./chrome-fake";
import { installBuildEnv, ok, outcome, run, same, section, show } from "./_harness";

const N = 1_800_000_000_000;
const MIN = 60_000;
const P = Keypair.random().publicKey();
const Q = Keypair.random().publicKey();

/** Run `fn` with Date.now() frozen at `fixed` (account.ts reads the real clock; this makes a boundary exact). */
async function atTime<T>(fixed: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => fixed;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

async function main() {
  /* ---------------------------------------- [a] ---------------------------------------- */
  section("a", "the reducer: unlock, touch, tick, lock");
  for (const m of [5, 15, 60]) {
    const v = reduce(LOCKED, { type: "unlock", pubkey: P, now: N, autolockMin: m });
    ok(`unlock with ${m} idle minutes: lockAt = now + ${m} minutes, for that account`, v.pubkey === P && v.lockAt === N + m * MIN && v.lockAt === lockAtFor(N, m));
  }
  const unlocked: SessionView = reduce(LOCKED, { type: "unlock", pubkey: P, now: N, autolockMin: 15 });
  ok("unlock replaces whatever was there (another account, an older deadline)", same(reduce({ pubkey: Q, lockAt: N - 1 }, { type: "unlock", pubkey: P, now: N, autolockMin: 15 }), unlocked));

  const t1 = reduce(unlocked, { type: "touch", now: N + 10 * MIN, autolockMin: 15 });
  ok("touch while unlocked moves lockAt to now + the idle period, for the same account", t1.pubkey === P && t1.lockAt === N + 25 * MIN);
  ok("  ...it follows the idle period it is given, even a shorter one", reduce(unlocked, { type: "touch", now: N + MIN, autolockMin: 5 }).lockAt === N + 6 * MIN);
  ok("  ...one ms before the deadline the session is still alive and is extended", reduce(unlocked, { type: "touch", now: unlocked.lockAt! - 1, autolockMin: 15 }).lockAt === unlocked.lockAt! - 1 + 15 * MIN);
  ok("touch exactly at lockAt is too late: locked", same(reduce(unlocked, { type: "touch", now: unlocked.lockAt!, autolockMin: 15 }), LOCKED));
  ok("touch after lockAt: locked", same(reduce(unlocked, { type: "touch", now: unlocked.lockAt! + 1, autolockMin: 15 }), LOCKED));
  ok("touch on a locked session does not unlock it", same(reduce(LOCKED, { type: "touch", now: N, autolockMin: 15 }), LOCKED));

  ok("tick before the deadline changes nothing (the very same view)", reduce(unlocked, { type: "tick", now: N + 14 * MIN }) === unlocked);
  ok("tick exactly at lockAt locks", same(reduce(unlocked, { type: "tick", now: unlocked.lockAt! }), LOCKED));
  ok("tick after lockAt locks", same(reduce(unlocked, { type: "tick", now: unlocked.lockAt! + 100 * MIN }), LOCKED));
  ok("tick on a locked session stays locked", same(reduce(LOCKED, { type: "tick", now: N }), LOCKED));
  ok("lock gives LOCKED (no account, no deadline), from any state", same(reduce(unlocked, { type: "lock" }), { pubkey: null, lockAt: null }) && same(reduce(LOCKED, { type: "lock" }), LOCKED));

  ok("isUnlocked is false at now === lockAt, true a ms before", !isUnlocked(unlocked, unlocked.lockAt!) && isUnlocked(unlocked, unlocked.lockAt! - 1));
  ok(
    "  ...and false for every half-state: no account, an empty account, no deadline, a non-numeric deadline",
    !isUnlocked(LOCKED, N) && !isUnlocked({ pubkey: "", lockAt: N + MIN }, N) && !isUnlocked({ pubkey: null, lockAt: N + MIN }, N) && !isUnlocked({ pubkey: P, lockAt: null }, N) && !isUnlocked({ pubkey: P, lockAt: "soon" as unknown as number }, N),
  );
  ok("canSign: the same account before the deadline", canSign(unlocked, N, P) && canSign(unlocked, unlocked.lockAt! - 1, P));
  ok("  ...not another account, not at or after the deadline, not when locked", !canSign(unlocked, N, Q) && !canSign(unlocked, unlocked.lockAt!, P) && !canSign(unlocked, unlocked.lockAt! + MIN, P) && !canSign(LOCKED, N, P));

  const frozen = Object.freeze({ pubkey: P, lockAt: N + MIN });
  let mutated = false;
  try {
    for (const e of [{ type: "touch", now: N, autolockMin: 15 }, { type: "tick", now: N + 5 * MIN }, { type: "lock" }, { type: "unlock", pubkey: Q, now: N, autolockMin: 5 }] as SessionEvent[]) reduce(frozen, e);
  } catch {
    mutated = true;
  }
  ok("reduce never mutates the view it is given", !mutated && frozen.lockAt === N + MIN && frozen.pubkey === P);

  // Over random event sequences (no unlock after the first): once locked it stays locked, and the
  // deadline is never further out than the longest idle period from the latest activity.
  {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let bad = "";
    for (let run = 0; run < 300 && !bad; run++) {
      let v: SessionView = reduce(LOCKED, { type: "unlock", pubkey: P, now: N, autolockMin: 15 });
      let now = N;
      let lockedOnce = false;
      for (let i = 0; i < 40 && !bad; i++) {
        now += Math.floor(rand() * 20 * MIN);
        const kind = rand();
        const m = [5, 15, 60][Math.floor(rand() * 3)]!;
        const e: SessionEvent = kind < 0.45 ? { type: "touch", now, autolockMin: m } : kind < 0.9 ? { type: "tick", now } : { type: "lock" };
        v = reduce(v, e);
        if (lockedOnce && v.pubkey !== null) bad = "a locked session came back without an unlock";
        if (v.pubkey === null) lockedOnce = true;
        if (v.pubkey !== null && (v.lockAt === null || v.lockAt > now + 60 * MIN)) bad = `deadline too far out: ${show(v)}`;
        if (canSign(v, now, P) && !isUnlocked(v, now)) bad = "canSign without isUnlocked";
        if (v.pubkey === null && v.lockAt !== null) bad = "half-locked view";
      }
    }
    ok("300 random touch / tick / lock sequences: a locked session never comes back, the deadline is never beyond the longest idle period", bad === "", bad);
  }

  /* ---------------------------------------- [b] ---------------------------------------- */
  section("b", "account.ts against a fake chrome: signerFor, lock, touch, isUnlockedNow");
  installBuildEnv();
  const fake = installChrome();
  const storage = await import("../src/lib/storage");
  storage.useAreas(fake.local, fake.session);
  const account = await import("../src/background/account");
  const { ExtError } = await import("../src/lib/errors");
  const { K } = storage;

  const kp = Keypair.random();
  const PUB = kp.publicKey();
  const SEED_B64 = Buffer.from(kp.rawSecretKey()).toString("base64");
  const otherKp = Keypair.random();
  const KEEP = { [K.restore]: { step: "code", email: "ayse@example.com", codeSentAt: N }, [K.pilot(PUB)]: { pilot: true, approved: true, state: "approved", used: 1, limit: 5, at: N } };

  async function put(over: { pubkey?: string | null; lockAt?: number | string | null; seed?: string | null } = {}): Promise<void> {
    await fake.session.clear();
    await fake.local.clear();
    fake.alarms.length = 0;
    const items: Record<string, unknown> = { ...KEEP };
    if (over.seed !== null) items[K.seed] = over.seed ?? SEED_B64;
    if (over.pubkey !== null) items[K.unlockedPubkey] = over.pubkey ?? PUB;
    if (over.lockAt !== null) items[K.lockAt] = over.lockAt ?? Date.now() + 10 * MIN;
    await fake.session.set(items);
  }
  const has = async (k: string) => (await fake.session.get(k)) !== undefined;
  const codeOf = (r: { value: unknown } | { error: unknown }): string => ("error" in r ? (r.error instanceof ExtError ? r.error.code : `non-ExtError: ${String(r.error)}`) : "returned");
  const wiped = async () => !(await has(K.seed)) && !(await has(K.unlockedPubkey)) && !(await has(K.lockAt));
  const keptOthers = async () => same(await fake.session.get(K.restore), KEEP[K.restore]) && same(await fake.session.get(K.pilot(PUB)), KEEP[K.pilot(PUB)]);
  const clearedAutolock = () => fake.alarms.some((a) => a.op === "clear" && a.name === account.AUTOLOCK_ALARM);

  // signerFor: the one door every signature goes through
  await put();
  const live = await outcome(account.signerFor(PUB));
  const signer = "value" in live ? live.value : null;
  ok("an unlocked session hands out a local signer for that account", signer !== null && signer.publicKey() === PUB && signer.kind === "local-ed25519");
  const msg = new TextEncoder().encode("lumenia self-test");
  const sig = signer?.signMessage ? await signer.signMessage(msg) : new Uint8Array();
  ok("  ...it signs with the real key (the signature verifies under the account's public key)", sig.length === 64 && Keypair.fromPublicKey(PUB).verify(Buffer.from(msg), Buffer.from(sig)));
  ok("  ...the seed stays stored for the next signature, and the signer keeps working after signerFor returned (it holds its own copy)", (await fake.session.get(K.seed)) === SEED_B64 && (await signer!.signMessage!(msg)).length === 64);
  ok("  ...a successful signature touches no other session key", await keptOthers());

  const NOW = N + 5_000_000;
  await put({ lockAt: NOW + 1 });
  ok("a ms before the deadline: still allowed", codeOf(await outcome(atTime(NOW, () => account.signerFor(PUB)))) === "returned");
  await put({ lockAt: NOW });
  ok("exactly at the deadline: locked (even though the seed is still stored)", codeOf(await outcome(atTime(NOW, () => account.signerFor(PUB)))) === "locked");
  ok("  ...and the refusal removed the seed, the account and the deadline from the session", (await wiped()) && (await keptOthers()));
  ok("  ...and cleared the auto-lock alarm", clearedAutolock());

  await put({ lockAt: Date.now() - 1 });
  ok("long past the deadline with the seed still stored: locked, never a signer", codeOf(await outcome(account.signerFor(PUB))) === "locked" && (await wiped()));

  await put();
  const wrong = await outcome(account.signerFor(otherKp.publicKey()));
  ok("a different account's key is refused (locked), not signed for", codeOf(wrong) === "locked");
  ok("  ...and refusing it wipes the session as well (fail closed)", await wiped());

  await put({ seed: null });
  ok("the seed is missing while the session says unlocked: locked", codeOf(await outcome(account.signerFor(PUB))) === "locked");
  ok("  ...and the leftover account and deadline are cleaned up", await wiped());

  await put({ pubkey: null, seed: null, lockAt: null });
  ok("an empty session: locked", codeOf(await outcome(account.signerFor(PUB))) === "locked");

  await put({ lockAt: "soon" });
  ok("a corrupt deadline (not a number): locked, never a signer", codeOf(await outcome(account.signerFor(PUB))) === "locked");
  ok("  ...and the seed that could never be used is wiped, not left lingering", await wiped());
  await put({ lockAt: null });
  ok("a seed with no deadline at all: locked, and wiped", codeOf(await outcome(account.signerFor(PUB))) === "locked" && (await wiped()));
  await put({ lockAt: null });
  const orphan = await account.isUnlockedNow();
  ok("isUnlockedNow on a seed with no deadline: locked, and the seed is wiped", orphan.unlocked === false && (await wiped()));

  await put({ seed: Buffer.from(otherKp.rawSecretKey()).toString("base64") });
  const mismatch = await outcome(account.signerFor(PUB));
  ok("a stored seed that is not the unlocked account's key never becomes a signer", "error" in mismatch && codeOf(mismatch) === "internal");

  // lock()
  await put();
  const l1 = await account.lock();
  ok("lock removes the seed, the unlocked account and the deadline, and returns null", l1 === null && (await wiped()));
  ok("  ...leaves every other session key alone (the restore in progress, the pilot answer)", await keptOthers());
  ok("  ...and clears the auto-lock alarm, exactly once", fake.alarms.filter((a) => a.op === "clear" && a.name === "autolock").length === 1);
  fake.alarms.length = 0;
  await account.lock();
  ok("lock on an already locked session is harmless", (await wiped()) && (await keptOthers()));

  // isUnlockedNow
  await put({ lockAt: Date.now() + 10 * MIN });
  const alive = await account.isUnlockedNow();
  ok("isUnlockedNow: alive session -> unlocked, with its deadline", alive.unlocked === true && alive.lockAt === (await fake.session.get(K.lockAt)));
  await put({ lockAt: Date.now() - 1 });
  const dead = await account.isUnlockedNow();
  ok("  ...expired session -> locked, no deadline, and the seed is wiped", dead.unlocked === false && dead.lockAt === null && (await wiped()));
  await put({ pubkey: null, seed: null, lockAt: null });
  ok("  ...nothing stored -> locked", same(await account.isUnlockedNow(), { unlocked: false, lockAt: null }));
  ok("sessionView reads the stored pair, or LOCKED", same(await account.sessionView(), LOCKED) && (await put(), (await account.sessionView()).pubkey === PUB));

  // touch()
  await fake.local.set({ [K.settings]: { net: "testnet", autolockMin: 5, mainnetAck: false, consentAt: N } });
  await fake.session.set({ [K.lockAt]: Date.now() + MIN });
  fake.alarms.length = 0;
  const before = Date.now();
  await account.touch();
  const after = Date.now();
  const moved = (await fake.session.get(K.lockAt)) as number;
  ok("touch pushes the deadline to now + the saved idle period (5 min here)", moved >= before + 5 * MIN && moved <= after + 5 * MIN, `${moved - before} ms`);
  const created = fake.alarms.filter((a) => a.op === "create");
  ok("  ...and schedules the auto-lock alarm for exactly that deadline", created.length === 1 && created[0]!.name === "autolock" && same(created[0]!.info, { when: moved }));
  ok("  ...the seed stays", (await fake.session.get(K.seed)) === SEED_B64);

  await put();
  const b2 = Date.now();
  await account.touch();
  const a2 = Date.now();
  const moved2 = (await fake.session.get(K.lockAt)) as number;
  ok("with no saved settings the idle period is the default 15 minutes", moved2 >= b2 + 15 * MIN && moved2 <= a2 + 15 * MIN);

  await put({ lockAt: Date.now() - 1 });
  await account.touch();
  ok("touch on an expired session locks it instead of extending it, and schedules nothing", (await wiped()) && !fake.alarms.some((a) => a.op === "create"));
  await put({ pubkey: null, seed: null, lockAt: null });
  fake.alarms.length = 0;
  await account.touch();
  ok("touch on a locked session does nothing at all", !(await has(K.lockAt)) && fake.alarms.length === 0);
}

run("SESSION", "the unlocked session (reducer + signerFor + lock)", main);
