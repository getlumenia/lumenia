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
 *
 * RUN: pnpm --filter @lumenia/web test:claimhome   (offline, no keys, no network)
 */
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
