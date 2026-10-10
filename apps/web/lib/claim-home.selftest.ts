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
    ok("a v2 claim with no home on the device saves its account as 'user' from the start", /savePhase1\(publicKey, seed, \(await getHome\(\)\) \? undefined : "user"\)/.test(claim));
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
