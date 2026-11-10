/**
 * Claim-home self-test: a v1 link's key (also the key of the account its money lands in, and for a
 * practice link one our server made) never becomes this device's home account (lib/claim-home.ts,
 * lib/keystore.ts adoptsHome).
 *
 *   [a] a device that already has a home: the link's account is kept as a throwaway, nothing else
 *   [b] a device with no home: a home is made from a FRESH key, the money is moved into it, and the
 *       link's account is closed and dropped
 *   [c] every failure after the claim leaves the money in the link's account, kept as a throwaway,
 *       and the link's key is never saved as anything else
 *   [d] the keystore rule: a throwaway is never adopted as home
 *   [e] bringing ANOTHER account here (lib/account-add.ts, W4): stored beside the one in use as a
 *       deliberate account, the pointer unmoved, both records "user"
 *   [f] the active account is never demoted: a record with no kind is pinned "user" before anything
 *       else becomes active, so /home's sweep can never select it and close it
 *   [g] the per-device limit refuses
 * [e] to [g] run the REAL keystore (lib/keystore.ts) over a small in-memory IndexedDB.
 *
 * The 2026-11 review fixes on the same route, same fakes:
 *   [h] P0-7: a v2 claim whose key cannot be kept is REFUSED before the relay (lib/claim-key.ts)
 *   [i] P0-8: a latch is a resume only while the keystore still holds its key; "Leave this device"
 *       drops the attempted latches (lib/lumendrop.ts, lib/keystore.ts hasAccountKey)
 *   [j] W3: an app's built-in browser is recognised, named, and the backup put first (lib/webview.ts)
 *   [k] W4: the Argon KEK and the claim's bearer refs are dropped on every path
 *
 * RUN: pnpm --filter @lumenia/web test:claimhome   (offline, no keys, no network)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { settleLinkAccount, type SettleDeps } from "./claim-home";
import { adoptsHome, type AccountKind } from "./keystore";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (cond) passed++;
  else failed++;
}
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

interface Calls {
  saved: { pubkey: string; kind: AccountKind; seed: string }[];
  opened: string[];
  swept: { seed: string; home: string; amount: string }[];
  removed: string[];
  sleeps: number;
}

function fakes(o: { home?: boolean; openFails?: boolean; balances?: (string | null)[]; sweepFails?: boolean; fresh: Keypair }): { deps: SettleDeps; calls: Calls } {
  const calls: Calls = { saved: [], opened: [], swept: [], removed: [], sleeps: 0 };
  let home: { pubkey: string } | null = o.home ? { pubkey: Keypair.random().publicKey() } : null;
  const balances = [...(o.balances ?? ["0.5000000"])];
  const deps: SettleDeps = {
    getHome: async () => home,
    saveAccount: async (pubkey, seed, kind) => {
      calls.saved.push({ pubkey, kind, seed: hex(seed) });
      // The keystore's own rule: the first non-throwaway account kept becomes home.
      if (!home && adoptsHome(kind)) home = { pubkey };
    },
    removeAccount: async (pubkey) => {
      calls.removed.push(pubkey);
    },
    openAccount: async (seed) => {
      calls.opened.push(Keypair.fromRawEd25519Seed(Buffer.from(seed)).publicKey());
      if (o.openFails) throw new Error("sponsor down");
    },
    balanceOf: async () => (balances.length > 1 ? balances.shift()! : balances[0] ?? null),
    sweep: async (seed, homePublicKey, amount) => {
      calls.swept.push({ seed: hex(seed), home: homePublicKey, amount });
      if (o.sweepFails) throw new Error("sweep refused");
    },
    newKeypair: () => o.fresh,
    sleep: async () => {
      calls.sleeps++;
    },
  };
  return { deps, calls };
}

async function main(): Promise<void> {
  console.log("============================================================");
  console.log(" SELF-TEST - claim home (a link's key never becomes the home account)");
  console.log("============================================================\n");

  {
    console.log("[a] a device that already has a home");
    const link = Keypair.random();
    const { deps, calls } = fakes({ home: true, fresh: Keypair.random() });
    const out = await settleLinkAccount(link, deps);
    ok("the outcome is kept-throwaway", out === "kept-throwaway", out);
    ok("the link's account is kept, as a throwaway", calls.saved.length === 1 && calls.saved[0]!.pubkey === link.publicKey() && calls.saved[0]!.kind === "throwaway");
    ok("  ...with the link's own key", calls.saved[0]?.seed === hex(link.rawSecretKey()));
    ok("no account is opened and nothing is moved (/home gathers it, as it always has)", calls.opened.length === 0 && calls.swept.length === 0 && calls.removed.length === 0);
  }

  {
    console.log("\n[b] a device with no home yet");
    const link = Keypair.random();
    const fresh = Keypair.random();
    const { deps, calls } = fakes({ fresh, balances: [null, "0", "0.5000000"] });
    const out = await settleLinkAccount(link, deps);
    ok("the outcome is moved-home", out === "moved-home", out);
    ok("the link's account is saved first, as a throwaway", calls.saved[0]?.pubkey === link.publicKey() && calls.saved[0]?.kind === "throwaway");
    ok("the account opened is the FRESH key, never the link's", calls.opened.length === 1 && calls.opened[0] === fresh.publicKey() && calls.opened[0] !== link.publicKey());
    ok("the fresh account is kept as a user account, so it becomes home", calls.saved[1]?.pubkey === fresh.publicKey() && calls.saved[1]?.kind === "user");
    ok("the link's key is never saved as anything but a throwaway", calls.saved.filter((x) => x.pubkey === link.publicKey()).every((x) => x.kind === "throwaway"));
    ok("the move waits for the ledger to show the money (two empty looks, then the balance)", calls.sleeps === 2);
    ok("the money moves from the link's account into the fresh home", calls.swept.length === 1 && calls.swept[0]!.home === fresh.publicKey() && calls.swept[0]!.amount === "0.5000000");
    ok("  ...signed with the link's key (the account that holds it)", calls.swept[0]?.seed === hex(link.rawSecretKey()));
    ok("the link's closed account is dropped from this device", calls.removed.length === 1 && calls.removed[0] === link.publicKey());
  }

  {
    console.log("\n[c] every failure after the claim leaves the money safe in the link's account");
    const link = Keypair.random();
    const a = fakes({ openFails: true, fresh: Keypair.random() });
    const outA = await settleLinkAccount(link, a.deps);
    ok("the sponsor cannot open a home: no-home, nothing moved", outA === "no-home" && a.calls.swept.length === 0 && a.calls.removed.length === 0, outA);
    ok("  ...and the only thing kept is the link's account, as a throwaway (it does not become home)", a.calls.saved.length === 1 && a.calls.saved[0]!.kind === "throwaway");

    const b = fakes({ balances: [null], fresh: Keypair.random() });
    const outB = await settleLinkAccount(link, b.deps);
    ok("the ledger never shows the money: home-made-money-waiting, nothing moved", outB === "home-made-money-waiting" && b.calls.swept.length === 0 && b.calls.removed.length === 0, outB);
    ok("  ...after eight looks", b.calls.sleeps === 7);

    const c = fakes({ sweepFails: true, fresh: Keypair.random() });
    const outC = await settleLinkAccount(link, c.deps);
    ok("the move is refused: home-made-money-waiting, the link's account is NOT dropped", outC === "home-made-money-waiting" && c.calls.removed.length === 0, outC);

    const d = fakes({ fresh: Keypair.random() });
    d.deps.balanceOf = async () => {
      throw new Error("horizon 503");
    };
    const outD = await settleLinkAccount(link, d.deps);
    ok("a balance read that throws counts as not shown yet, never as an answer", outD === "home-made-money-waiting" && d.calls.swept.length === 0, outD);
  }

  console.log("\n[d] the keystore rule");
  ok("a throwaway is never adopted as home", adoptsHome("throwaway") === false);
  ok("a user account is", adoptsHome("user") === true);
  ok("a record written before kinds existed is, as before", adoptsHome(undefined) === true);

  await accountsOnOneDevice();
}

/* ---------------------------------------------------------------------------
 * A minimal IndexedDB: one database, object stores keyed by "id", the calls lib/keystore.ts makes
 * (open with an upgrade, put, get, getAll, delete, clear). A request answers on a later tick and a
 * transaction completes after its requests, which is the order the keystore relies on.
 * ------------------------------------------------------------------------- */
type Handler = ((this: unknown) => void) | null;
interface FakeRequest {
  result?: unknown;
  error: unknown;
  onsuccess: Handler;
  onerror: Handler;
  onupgradeneeded?: Handler;
  transaction?: unknown;
}
function installFakeIndexedDB(): void {
  const dbs = new Map<string, { version: number; stores: Map<string, Map<string, unknown>> }>();
  const later = (fn: () => void) => setTimeout(fn, 0);
  const afterRequests = (fn: () => void) => later(() => later(fn));
  const request = (run: () => unknown): FakeRequest => {
    const req: FakeRequest = { error: null, onsuccess: null, onerror: null };
    try {
      req.result = run();
      later(() => req.onsuccess?.call(req));
    } catch (e) {
      req.error = e;
      later(() => req.onerror?.call(req));
    }
    return req;
  };
  const storeOf = (stores: Map<string, Map<string, unknown>>, name: string) => {
    const m = stores.get(name);
    if (!m) throw new Error(`no object store ${name}`);
    return {
      put: (rec: { id: string }) => request(() => (m.set(rec.id, rec), rec.id)),
      get: (id: string) => request(() => m.get(id)),
      getAll: () => request(() => [...m.values()]),
      delete: (id: string) => request(() => void m.delete(id)),
      clear: () => request(() => void m.clear()),
    };
  };
  const transaction = (stores: Map<string, Map<string, unknown>>) => {
    const tx = { error: null, oncomplete: null as Handler, onerror: null as Handler, objectStore: (n: string) => storeOf(stores, n) };
    afterRequests(() => tx.oncomplete?.call(tx));
    return tx;
  };
  (globalThis as unknown as { indexedDB: unknown }).indexedDB = {
    open(name: string, version: number) {
      const req: FakeRequest = { error: null, onsuccess: null, onerror: null };
      later(() => {
        let db = dbs.get(name);
        const upgrade = !db || db.version < version;
        if (!db) dbs.set(name, (db = { version, stores: new Map() }));
        const stores = db.stores;
        req.result = {
          objectStoreNames: { contains: (n: string) => stores.has(n) },
          createObjectStore: (n: string) => void stores.set(n, new Map()),
          transaction: () => transaction(stores),
          close: () => undefined,
        };
        if (upgrade) {
          db.version = version;
          req.transaction = transaction(stores);
          req.onupgradeneeded?.call(req);
        }
        afterRequests(() => req.onsuccess?.call(req));
      });
      return req;
    },
  };
}

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (...parts: string[]): string => readFileSync(join(WEB_ROOT, ...parts), "utf8");
async function throwsWith(fn: () => Promise<unknown>): Promise<Error | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

async function accountsOnOneDevice(): Promise<void> {
  installFakeIndexedDB();
  const ks = await import("./keystore");
  const add = await import("./account-add");
  const { MAX_USER_ACCOUNTS } = await import("./new-account");
  const { wrapWithPassword, emptyBox, putCopy } = await import("./recovery");
  const FAST = { memMiB: 19, time: 2, parallelism: 1 }; // the Argon2id bounds' minimums, as test:recovery
  const seedOf = (k: Keypair) => Uint8Array.from(k.rawSecretKey());
  const boxFor = async (k: Keypair, pw: string) => putCopy(emptyBox(), await wrapWithPassword(seedOf(k), pw, FAST));
  const PW = "another strong one 42";

  console.log("\n[e] bringing another account here, while a published home exists (W4)");
  {
    const home = Keypair.random();
    // A home with NO kind: a v2 claim's account on a fresh device, or any record older than kinds.
    await ks.savePhase1(home.publicKey(), seedOf(home));
    await ks.markPublished(home.publicKey());
    ok("the setup: a kindless, published home is the active account", (await ks.getActive())?.pubkey === home.publicKey() && (await ks.isPublished(home.publicKey())));
    const other = Keypair.random();
    let tiedWith: string | null = null;
    const out = await add.addRestoredAccount(await boxFor(other, PW), PW, async (signer) => {
      tiedWith = signer.publicKey();
    }, FAST);
    const list = await ks.listAccounts();
    ok("the restored account is stored beside it", out.address === other.publicKey() && !out.alreadyHere && list.length === 2);
    ok("  ...both records are 'user'", list.every((a) => a.kind === "user"));
    ok("  ...and the pointer has not moved", (await ks.getActive())?.pubkey === home.publicKey());
    ok("afterSave ran with the restored account's own signer (to tie its backup row)", tiedWith === other.publicKey());
    const unlocked = await ks.unlockPhase2(PW, other.publicKey());
    ok("it is locked with the backup's own password, and opens to the restored key", Keypair.fromRawEd25519Seed(Buffer.from(unlocked.seed)).publicKey() === other.publicKey());
    await ks.setActive(other.publicKey());
    const after = await ks.listAccounts();
    ok("the old home was PINNED 'user', so it stays one once the other is active", after.find((a) => a.pubkey === home.publicKey())?.kind === "user");
    const swept = after.filter((a) => a.pubkey !== other.publicKey() && a.kind !== "user");
    ok("  ...and /home's sweep filter (a.address !== home && a.kind !== 'user') never selects it", swept.length === 0);
    const strangerBox = await boxFor(Keypair.random(), PW);
    const wrong = await throwsWith(() => add.addRestoredAccount(strangerBox, "not the password", undefined, FAST));
    ok("a wrong password: the contract's sentence, and nothing stored", wrong?.message === "That password doesn't open this backup." && (await ks.listAccounts()).length === 2);
    const again = await add.addRestoredAccount(await boxFor(other, PW), PW, undefined, FAST);
    ok("an account that is already here is left as it is", again.alreadyHere && (await ks.listAccounts()).length === 2);
  }

  console.log("\n[f] the active account is never demoted (W4, pinActiveAsUser)");
  {
    await ks.clearKeystore();
    const home = Keypair.random();
    const second = Keypair.random();
    await ks.savePhase1(home.publicKey(), seedOf(home)); // kindless home
    await ks.savePhase1(second.publicKey(), seedOf(second), "user");
    await ks.setActive(second.publicKey());
    ok("CONTROL: without the pin, a kindless home reads as a throwaway once another account is active", (await ks.listAccounts()).find((a) => a.pubkey === home.publicKey())?.kind === "throwaway");
    await ks.setActive(home.publicKey());
    ok("pinActiveAsUser writes 'user' onto the kindless active record", (await add.pinActiveAsUser()) === true);
    ok("  ...once: a record with a kind is left alone", (await add.pinActiveAsUser()) === false);
    await ks.setActive(second.publicKey());
    const list = await ks.listAccounts();
    ok("now it stays 'user' after the pointer moves", list.find((a) => a.pubkey === home.publicKey())?.kind === "user");
    ok("  ...so the sweep filter never selects it", list.filter((a) => a.pubkey !== second.publicKey() && a.kind !== "user").length === 0);

    const wallet = source("lib", "wallet.tsx");
    ok("the wallet pins before a new account becomes active", /await pinActiveAsUser\(\);\s*const \{ address \} = await createUserAccount\(/.test(wallet));
    ok("  ...before a switch moves the pointer", /await pinActiveAsUser\(\);[\s\S]{0,200}await setActive\(address\);/.test(wallet));
    ok("  ...before a restore is adopted", /const adoptRestored = useCallback\(async \(pub: string\): Promise<void> => \{[\s\S]{0,400}await pinActiveAsUser\(\)/.test(wallet));
    ok("  ...and once after the first read of the keystore", /refresh\(\)\.then\(\(\) => pinActiveAsUser\(\)/.test(wallet));
    const claim = source("app", "v2", "c", "[linkHex]", "V2ClaimButton.tsx");
    ok(
      "a v2 claim keeps its account through keepClaimKey, with the device's home lookup and savePhase1",
      /await keepClaimKey\(publicKey, seed, \{\s*save: savePhase1,\s*hasHome: async \(\) => \(await getHome\(\)\) !== null,?\s*\}\)/.test(claim),
    );
  }

  console.log("\n[g] the per-device limit");
  {
    await ks.clearKeystore();
    for (let i = 0; i < MAX_USER_ACCOUNTS; i++) {
      const k = Keypair.random();
      await ks.savePhase1(k.publicKey(), seedOf(k), "user");
    }
    const e = await throwsWith(async () => add.addRestoredAccount(await boxFor(Keypair.random(), PW), PW, undefined, FAST));
    ok(`a ${MAX_USER_ACCOUNTS + 1}th account is refused`, e?.message === `You already have ${MAX_USER_ACCOUNTS} accounts on this phone.`);
    ok("  ...and nothing was stored", (await ks.listAccounts()).length === MAX_USER_ACCOUNTS);
  }

  await claimKeyRefusal();
  await latchNeedsKey(ks);
  await inAppBrowser();
  await secretsDropped(ks);
}

type Keystore = typeof import("./keystore");

/** A minimal localStorage for the latch tests: the calls lib/lumendrop.ts makes, over a Map. */
function installFakeLocalStorage(): Map<string, string> {
  const m = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    key: (i: number) => [...m.keys()][i] ?? null,
    clear: () => m.clear(),
    get length() {
      return m.size;
    },
  };
  return m;
}

/* [h] P0-7. The claim mints a sponsored account, hands this device the key, and only then relays the
   money. The old onAccountReady swallowed a failed save and let the relay run: with storage blocked
   the money landed in an account nobody held a key for. Now the save failing ends the claim. */
async function claimKeyRefusal(): Promise<void> {
  console.log("\n[h] a claim whose key cannot be kept is refused before the relay (P0-7)");
  const { keepClaimKey, isStorageBlocked, StorageBlockedError, STORAGE_BLOCKED } = await import("./claim-key");
  const saved: { pubkey: string; kind: AccountKind | undefined; seed: string }[] = [];
  const save = async (pubkey: string, seed: Uint8Array, kind?: AccountKind) => {
    saved.push({ pubkey, kind, seed: hex(seed) });
  };
  {
    const k = Keypair.random();
    const seed = Uint8Array.from(k.rawSecretKey());
    const expected = hex(seed);
    await keepClaimKey(k.publicKey(), seed, { save, hasHome: async () => false });
    ok("no home on the device: the claim's account is kept as 'user' (it becomes home), with the seed it was given", saved[0]?.pubkey === k.publicKey() && saved[0]?.kind === "user" && saved[0]?.seed === expected);
    ok("  ...and the seed buffer is zeroed after the save", seed.every((b) => b === 0));
  }
  {
    const k = Keypair.random();
    await keepClaimKey(k.publicKey(), Uint8Array.from(k.rawSecretKey()), { save, hasHome: async () => true });
    ok("a home exists: the claim's account is kept kindless, for /home to gather in", saved[1]?.pubkey === k.publicKey() && saved[1]?.kind === undefined);
  }
  {
    const k = Keypair.random();
    const seed = Uint8Array.from(k.rawSecretKey());
    const blocked = new Error("InvalidStateError: A mutation operation was attempted on a database that did not allow mutations.");
    const e = await throwsWith(() =>
      keepClaimKey(k.publicKey(), seed, {
        save: async () => {
          throw blocked;
        },
        hasHome: async () => false,
      }),
    );
    ok("a save the browser refuses is a StorageBlockedError, not a swallowed failure", e instanceof StorageBlockedError && isStorageBlocked(e));
    ok("  ...carrying the plain sentence and the cause", e?.message === STORAGE_BLOCKED && (e as Error & { cause?: unknown })?.cause === blocked);
    ok("  ...with the seed zeroed on that path too", seed.every((b) => b === 0));
    ok("  ...and nothing stored", saved.length === 2);
  }
  {
    const k = Keypair.random();
    const e = await throwsWith(() =>
      keepClaimKey(k.publicKey(), Uint8Array.from(k.rawSecretKey()), {
        save,
        hasHome: async () => {
          throw new Error("indexedDB is not available");
        },
      }),
    );
    ok("a home lookup the browser refuses is the same refusal", isStorageBlocked(e) && saved.length === 2);
  }
  ok("isStorageBlocked names the class, never the wording", !isStorageBlocked(new Error(STORAGE_BLOCKED)) && isStorageBlocked({ name: "StorageBlockedError" }));

  /* The seams, read from the source: the refusal is only a refusal if nothing runs after it. */
  const claim = source("app", "v2", "c", "[linkHex]", "V2ClaimButton.tsx");
  const start = claim.indexOf("onAccountReady: async (publicKey, seed) => {");
  const ready = start < 0 ? "" : claim.slice(start, claim.indexOf("\n      });", start));
  ok("the claim screen's onAccountReady keeps the key through keepClaimKey and catches nothing", ready.includes("await keepClaimKey(publicKey, seed, {") && !/\bcatch\b/.test(ready));
  ok("  ...and names a refused save by class, with no retry button", /isStorageBlocked\(e\)/.test(claim) && /detail: "this browser blocks saving", retryable: false/.test(claim));
  const iReady = claim.indexOf("await keystoreReady()");
  const iClaim = claim.indexOf("await claimV2ToSponsoredAccount(");
  ok("  ...and asks whether the keystore opens at all BEFORE anything is minted", iReady > 0 && iReady < iClaim);
  const drop = source("lib", "lumendrop.ts");
  const iCall = drop.indexOf("await opts.onAccountReady?.(");
  const iLatch = drop.indexOf('writeClaimLatch(linkHex, { state: "attempted"');
  const iRelay = drop.indexOf("await claimV2({");
  ok("lumendrop awaits onAccountReady BEFORE the attempted latch and BEFORE the relay, so a throw there relays nothing", iCall > 0 && iCall < iLatch && iLatch < iRelay);
  ok("  ...and the claimed outcome carries no second copy of the seed", !/kind: "claimed";[\s\S]{0,400}seed: Uint8Array/.test(drop));
}

/* [i] P0-8. The latch (localStorage) outlives the keystore (IndexedDB): "Leave this device" clears
   the second, and a resume into the account the latch names paid the drop into a keyless account. */
async function latchNeedsKey(ks: Keystore): Promise<void> {
  console.log("\n[i] a latch is a resume only while this phone still holds its key (P0-8)");
  const store = installFakeLocalStorage();
  const ld = await import("./lumendrop");
  const latch = { state: "attempted" as const, payout: Keypair.random().publicKey(), link: "group" as const, at: 1 };
  const taken = { ...latch, state: "taken" as const };

  console.log("  the pure decision (resumeDecision), with the key gone:");
  ok("a taken latch: the money landed in an account this phone no longer holds", JSON.stringify(ld.resumeDecision({ latch: taken, payoutUsd: null, claimable: null, held: false })) === JSON.stringify({ say: "unheld", landed: true }));
  ok("an attempted latch whose old account holds money: the same", JSON.stringify(ld.resumeDecision({ latch, payoutUsd: "0.5000000", claimable: null, held: false })) === JSON.stringify({ say: "unheld", landed: true }));
  ok("  ...even dust", ld.resumeDecision({ latch, payoutUsd: "0.0000001", claimable: true, held: false }).say === "unheld");
  ok("an attempted latch whose old account could not be read: unheld, undecided, nothing offered", JSON.stringify(ld.resumeDecision({ latch, payoutUsd: null, claimable: true, held: false })) === JSON.stringify({ say: "unheld", landed: null }));
  ok("  ...and the same when the link could not be read", JSON.stringify(ld.resumeDecision({ latch, payoutUsd: "0", claimable: null, held: false })) === JSON.stringify({ say: "unheld", landed: null }));
  ok("an empty old account and a link that can still pay: a FRESH claim, said honestly", JSON.stringify(ld.resumeDecision({ latch, payoutUsd: "0", claimable: true, held: false })) === JSON.stringify({ say: "unheld", landed: false }));
  ok("an empty old account and a link that cannot pay: missed, as before", ld.resumeDecision({ latch, payoutUsd: "0", claimable: false, held: false }).say === "missed");
  ok("with the key held (or `held` left out) every old answer stands", ld.resumeDecision({ latch, payoutUsd: "0", claimable: true, held: true }).say === "resume" && ld.resumeDecision({ latch, payoutUsd: "0", claimable: true }).say === "resume" && ld.resumeDecision({ latch, payoutUsd: "0.5000000", claimable: null }).say === "taken" && ld.resumeDecision({ latch, payoutUsd: null, claimable: null }).say === "unsure");
  ok("no latch says nothing, key or no key", ld.resumeDecision({ latch: null, payoutUsd: "0", claimable: true, held: false }).say === "nothing");

  console.log("  the keystore's answer (hasAccountKey, keystoreReady):");
  await ks.clearKeystore();
  const k = Keypair.random();
  ok("an account this phone never kept: no key", (await ks.hasAccountKey(k.publicKey())) === false);
  await ks.savePhase1(k.publicKey(), Uint8Array.from(k.rawSecretKey()), "user");
  ok("after savePhase1: held", (await ks.hasAccountKey(k.publicKey())) === true);
  await ks.clearKeystore();
  ok("after Leave this device (clearKeystore): gone", (await ks.hasAccountKey(k.publicKey())) === false);
  ok("the keystore opens here", (await ks.keystoreReady()) === true);
  {
    const g = globalThis as unknown as { indexedDB: unknown };
    const real = g.indexedDB;
    g.indexedDB = {
      open() {
        throw new Error("InvalidStateError: blocked");
      },
    };
    ok("a browser that refuses to open it answers false (the claim then stops before minting)", (await ks.keystoreReady()) === false);
    ok("  ...and hasAccountKey answers false rather than throwing", (await ks.hasAccountKey(k.publicKey())) === false);
    g.indexedDB = real;
  }

  console.log("  forgetAttemptedClaims, over the latches on this phone:");
  const hexId = () => Buffer.from(Keypair.random().rawPublicKey()).toString("hex");
  const a1 = `lumenia.v2claim.${hexId()}`;
  const a2 = `lumenia.v2claim.${hexId()}`;
  const t1 = `lumenia.v2claim.${hexId()}`;
  const junk = `lumenia.v2claim.${hexId()}`;
  store.set(a1, JSON.stringify(latch));
  store.set(a2, JSON.stringify({ ...latch, link: "single" }));
  store.set(t1, JSON.stringify(taken));
  store.set(junk, "{not json");
  store.set("lumenia.sent.testnet", JSON.stringify({ abc: { balanceId: "00".repeat(32) } }));
  store.set("lumenia.net", "public");
  const dropped = ld.forgetAttemptedClaims();
  ok("every attempted latch goes, and an unreadable one with it", dropped === 3 && !store.has(a1) && !store.has(a2) && !store.has(junk));
  ok("a taken latch stays: money LANDED in that account, and a reopen must say so rather than pay a second share", store.has(t1) && ld.readClaimLatch(t1.slice("lumenia.v2claim.".length))?.state === "taken");
  ok("the sent-links list and every other key are untouched", store.has("lumenia.sent.testnet") && store.has("lumenia.net"));
  ok("a second pass has nothing to drop", ld.forgetAttemptedClaims() === 0);

  console.log("  the seams, read from the source:");
  const leave = source("components", "brand", "DisconnectButton.tsx");
  const iClear = leave.indexOf("await clearKeystore();");
  const iForget = leave.indexOf("forgetAttemptedClaims();");
  ok("Leave this device drops the attempted latches right after the keystore", iClear > 0 && iForget > iClear);
  const claim = source("app", "v2", "c", "[linkHex]", "V2ClaimButton.tsx");
  ok("the claim screen hands its keystore to BOTH the mount-time read and the tap", /readClaimProgress\(linkHex, \{[^}]*hasKeyFor: hasAccountKey/.test(claim) && /hasKeyFor: hasAccountKey,\s*\n/.test(claim.slice(claim.indexOf("await claimV2ToSponsoredAccount("))));
  const drop = source("lib", "lumendrop.ts");
  const fn = drop.slice(drop.indexOf("export async function claimV2ToSponsoredAccount("));
  ok("the tap asks the keystore before it reuses the latched payout", fn.indexOf("opts.hasKeyFor") > 0 && fn.indexOf("opts.hasKeyFor") < fn.indexOf("payoutPublic = latch.payout") && /if \(latch && held\) \{\s*payoutPublic = latch\.payout;/.test(fn));
  ok("  ...reads the old account on a pool before minting a fresh payout, and stops when it cannot", /else if \(latch && kind === "group"\) \{[\s\S]*?if \(usd === null\) throw new PriorAttemptUnreadError\(\);[\s\S]*?held: false/.test(fn));
  ok("  ...and a taken group latch answers with whether the key is still held", /return \{ kind: "already-yours", publicKey: latch\.payout, link: latch\.link, held \};/.test(fn));
  ok("the screen never says 'on this phone' about an account it no longer holds", /if \(!held\) \{[\s\S]*?removed from this phone[\s\S]*?restore: true/.test(claim) && /settledCopy\(settled\.kind, sender, settled\.link, settled\.amount, settled\.held\)/.test(claim));
}

/* [j] W3. The key goes into the IndexedDB of whatever context runs the page, and an app's built-in
   browser has its own. The screen must say which browser holds it, and put the backup first. */
async function inAppBrowser(): Promise<void> {
  console.log("\n[j] an app's built-in browser is recognised, named, and the backup put first (W3)");
  const wv = await import("./webview");
  const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A.240405.002";
  const cases: [string, string, { app: string; os: string } | null][] = [
    ["iOS Safari", `${IOS} Version/17.5 Mobile/15E148 Safari/604.1`, null],
    ["iOS Chrome", `${IOS} CriOS/125.0.6422.80 Mobile/15E148 Safari/604.1`, null],
    ["iOS Firefox", `${IOS} FxiOS/125.0 Mobile/15E148 Safari/605.1.15`, null],
    ["an iPhone WKWebView with no app token (WhatsApp's shape)", `${IOS} Mobile/15E148`, { app: "an app", os: "ios" }],
    ["Instagram on iOS", `${IOS} Mobile/15E148 Instagram 334.0.4.32.98 (iPhone15,2; iOS 17_5; en_US; en; scale=3.00; 1179x2556; 603876290)`, { app: "Instagram", os: "ios" }],
    ["Facebook on iOS", `${IOS} Mobile/15E148 [FBAN/FBIOS;FBAV/467.0.0.36.107;FBBV/621093385;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBID/phone;FBLC/en_US;FBOP/5]`, { app: "Facebook", os: "ios" }],
    ["X on iOS", `${IOS} Mobile/15E148 Twitter for iPhone/10.37`, { app: "X", os: "ios" }],
    ["LinkedIn on iOS", `${IOS} Mobile/15E148 LinkedInApp`, { app: "LinkedIn", os: "ios" }],
    ["Android Chrome, also what WhatsApp's custom tab sends (Chrome's own storage)", `${ANDROID}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36`, null],
    ["an Android WebView with no app token", `${ANDROID}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36`, { app: "an app", os: "android" }],
    ["Instagram on Android", `${ANDROID}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36 Instagram 334.0.0.42.95 Android (34/14; 420dpi; 1080x2268; Google/google; Pixel 8; shiba; shiba; en_US; 603955208)`, { app: "Instagram", os: "android" }],
    ["Facebook on Android", `${ANDROID}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/462.0.0.33.74;]`, { app: "Facebook", os: "android" }],
    ["Samsung Internet", "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36", null],
    ["Firefox on Android", "Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0", null],
    ["desktop Chrome (what the e2e suite runs as)", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36", null],
    ["iPad Safari asking for the desktop site", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", null],
    ["an empty user agent", "", null],
  ];
  for (const [name, ua, want] of cases) {
    const got = wv.detectInAppBrowser(ua);
    ok(`${name}: ${want ? `${want.app} on ${want.os}` : "a real browser"}`, JSON.stringify(got) === JSON.stringify(want), got ? `${got.app}/${got.os}` : "null");
  }
  ok("a home-screen web app on iOS has the WKWebView shape and is told apart by standalone", wv.detectInAppBrowser(`${IOS} Mobile/15E148`, { standalone: true }) === null);

  console.log("  what the screen then says:");
  const whatsapp = wv.doneScreenPlan(wv.detectInAppBrowser(`${IOS} Mobile/15E148 WhatsApp/24.10.78`));
  ok("WhatsApp on iOS: the key holder is named, Safari is where to look, and the way there is copying the address", JSON.stringify(whatsapp) === JSON.stringify({ inApp: true, holder: "WhatsApp's built-in browser", browser: "Safari", escape: "copy" }));
  const notice = wv.keyHolderNotice(whatsapp) ?? "";
  ok("  ...the notice names both, and says to back up", notice.includes("WhatsApp's built-in browser") && notice.includes("not in Safari") && /back it up/i.test(notice));
  const insta = wv.doneScreenPlan(wv.detectInAppBrowser(cases[10]![1]));
  ok("Instagram on Android: Chrome, by intent", JSON.stringify(insta) === JSON.stringify({ inApp: true, holder: "Instagram's built-in browser", browser: "Chrome", escape: "intent" }));
  ok("an unnamed WebView is 'this app's built-in browser'", (wv.doneScreenPlan(wv.detectInAppBrowser(cases[9]![1])) as { holder?: string }).holder === "this app's built-in browser");
  ok("a real browser: the screen is exactly what it was", JSON.stringify(wv.doneScreenPlan(null)) === JSON.stringify({ inApp: false }) && wv.keyHolderNotice({ inApp: false }) === null && wv.escapeOffer(null) === null);
  ok("the pre-claim offer exists on Android only; iOS completes the claim where it is", (wv.escapeOffer(wv.detectInAppBrowser(cases[9]![1])) ?? "").includes("Open this link in Chrome") && wv.escapeOffer(wv.detectInAppBrowser(`${IOS} Mobile/15E148`)) === null);

  console.log("  the Android intent:");
  const link = "https://getlumenia.com/v2/c/3f9a8c2b?n=public&g=6#SB4KEYSECRET&s=Meri%C3%A7&p=1";
  const href = wv.androidIntentHref(link);
  ok("the page, with its fragment, then the Intent block last", href.startsWith("intent://getlumenia.com/v2/c/3f9a8c2b?n=public&g=6#SB4KEYSECRET&s=Meri%C3%A7&p=1#Intent;scheme=https;package=com.android.chrome;") && href.endsWith(";end"));
  ok("the key never moves into the path or the query", href.slice(0, href.indexOf("#")).includes("SB4KEYSECRET") === false);
  ok("the fallback is the same link, encoded", href.includes(`S.browser_fallback_url=${encodeURIComponent(link)};`));

  console.log("  the screen's order, read from the source:");
  const claim = source("app", "v2", "c", "[linkHex]", "V2ClaimButton.tsx");
  const done = claim.slice(claim.indexOf('if (state === "done") {'), claim.indexOf('if (state === "settled" && settled)'));
  const iBackup = done.indexOf('href="/account#backup"');
  // The JSX text sits on a line of its own; the comments above it mention the words too.
  const seeMoney = [...done.matchAll(/^\s*See my money$/gm)].map((m) => m.index ?? -1);
  ok("in an app's browser the backup link comes BEFORE 'See my money'", iBackup > 0 && seeMoney.length > 0 && iBackup < seeMoney[0]! && /plan\.inApp \? \(/.test(done));
  ok("  ...the notice is rendered, and the open-in-browser step offers the intent on Android and the address on iOS", done.includes("{notice}") && done.includes("androidIntentHref(`${site}/start`)") && done.includes("copyAddress()"));
  ok("  ...and the real-browser branch is the single 'See my money' it always was", seeMoney.length === 2 && !/plan\.inApp \? \([\s\S]*\) : \([\s\S]*Back up my money/.test(done));
  ok("the pre-claim offer on Android hands Chrome the link WITH its key (fullLink), never a stripped one", /androidIntentHref\(fullLink\(\)\)/.test(claim) && /fragmentRef\.current = frag;/.test(claim));
}

/* [k] W4. Secrets were zeroed only on success paths. */
async function secretsDropped(ks: Keystore): Promise<void> {
  console.log("\n[k] the KEK and the claim's bearer refs are dropped on every path (W4)");
  const FAST = { memMiB: 19, time: 2, parallelism: 1 };
  await ks.clearKeystore();
  const k = Keypair.random();
  await ks.savePhase2(k.publicKey(), Uint8Array.from(k.rawSecretKey()), "right one", FAST, "user");
  const wrong = await throwsWith(() => ks.unlockPhase2("wrong one", k.publicKey()));
  ok("a wrong password still throws out of unlockPhase2 (the finally does not swallow it)", wrong !== null);
  const right = await ks.unlockPhase2("right one", k.publicKey());
  ok("  ...and the right one still opens the key", Keypair.fromRawEd25519Seed(Buffer.from(right.seed)).publicKey() === k.publicKey());
  const keystore = source("lib", "keystore.ts");
  const save2 = keystore.slice(keystore.indexOf("export async function savePhase2("), keystore.indexOf("export async function unlockPhase2("));
  const unlock2 = keystore.slice(keystore.indexOf("export async function unlockPhase2("));
  ok("savePhase2 zeroes the KEK in a finally", /try \{[\s\S]*?encrypt\([\s\S]*?\} finally \{[\s\S]*?kekBytes\.fill\(0\);/.test(save2));
  ok("unlockPhase2 zeroes the KEK in a finally, so a wrong password zeroes it too", /try \{[\s\S]*?decrypt\([\s\S]*?\} finally \{[\s\S]*?kekBytes\.fill\(0\);/.test(unlock2));
  const drop = source("lib", "lumendrop.ts");
  ok("the claim wipes the payout Keypair in a finally around the mint", /\} finally \{[\s\S]{0,400}wipeKeypair\(payout\);/.test(drop) && /k\.rawSecretKey\(\)\.fill\(0\)/.test(drop));
  const claim = source("app", "v2", "c", "[linkHex]", "V2ClaimButton.tsx");
  ok("the claim screen drops its refs when the claim lands or settles, on a refusal with no retry, and on unmount", (claim.match(/dropKey\(\);/g) ?? []).length >= 5 && /if \(!info\.retryable\) dropKey\(\);/.test(claim) && /if \(gone\.current\) dropKey\(\);/.test(claim));
  ok("  ...but keeps them for a retry (a locked link re-enters the password against the half-key)", !/setFailure\(info\);\s*setState\("error"\);\s*dropKey\(\);/.test(claim));
}

void main().then(
  () => {
    console.log(`\n${failed === 0 ? "PASS" : "FAIL"} CLAIM HOME SELF-TEST ${passed}/${passed + failed}`);
    if (failed > 0) process.exit(1);
  },
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
