/**
 * v2 client — the browser side of the deployed LumenDrop Soroban escrow (RECOVERY/§ V2 doc).
 * The v2 primitive: the link key doesn't hold the money — it authorizes a payout chosen AT CLAIM
 * TIME. So there is no per-recipient reserve, no throwaway-account fragmentation, and no sweep.
 *
 *   createV2Link — a sender deposits USDC behind a fresh ephemeral link key (Soroban invoke).
 *   claimV2      — a recipient picks a payout NOW, the link key signs it, and the sponsor RELAYER
 *                  submits the claim + pays the Soroban fee (walletless + gasless). Proven on-chain
 *                  (7/7) + the relayer path is exercised against the live contract.
 *
 * The link secret (an Ed25519 private key = a Stellar S… secret) lives only in the URL #fragment.
 */
import {
  rpc,
  Account,
  Horizon,
  Address,
  Contract,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";
import type { Signer } from "./signer";
import { resolveNetwork, activeNetwork, type NetworkConfig } from "./network";
import { deriveLinkKey, makeLinkSeed, passwordFragment } from "./claim-password";
import { assertSponsoredOnboarding } from "./tx-guard";

import { netKey } from "./scoped-store";
/**
 * Every v2 call takes an optional network; omitting it means THE NETWORK THIS DEVICE IS ON.
 *
 * It used to mean testnet, frozen at import via `resolveNetwork(undefined)` — and that was not a
 * stale-capture bug that a reload could clear, it could never be anything but testnet. So on real
 * money the deposit was built against the testnet RPC, the testnet passphrase and the testnet
 * escrow, then posted to the mainnet sponsor: sending failed outright, and `loadReclaimableV2`
 * searched the testnet escrow for mainnet drops, so an unclaimed real-money link never appeared on
 * /notifications and its dollars sat past expiry with no way back in the UI.
 *
 * A claim link still carries its own network (`?n=public`) and passes it through explicitly — the
 * recipient's device has no prior state to read, which is the entire point of the product.
 */
function defaultNet(): NetworkConfig {
  return activeNetwork();
}

/**
 * Lookup order for an EXISTING drop on a given network: the current escrow first, then each
 * SUPERSEDED one. A drop can only ever be released by the contract that holds it, so after an
 * upgrade the app must keep reading and exiting the old ones — otherwise a link already sitting
 * in someone's chat silently stops resolving. Superseded escrows are never written to.
 */
const dropContracts = (net: NetworkConfig): string[] => [
  net.contract,
  ...net.legacyContracts.filter((c) => c !== net.contract),
];
const UNIT = 10_000_000n; // 1 USDC = 1e7 stroops

/* Split the decimal string; never multiply a float by 1e7. Past ~$900M that product crosses
   MAX_SAFE_INTEGER before the rounding can catch it, and the escrow would be handed an amount that
   is not the one the sender typed. Same conversion lib/horizon.ts sums balances with. */
const usdcStroops = (amount: string): bigint => {
  const [whole, frac = ""] = amount.trim().split(".");
  return BigInt(whole || "0") * UNIT + BigInt(`${frac}0000000`.slice(0, 7));
};
const stroopsToUsdc = (s: bigint): string => {
  const neg = s < 0n;
  const a = neg ? -s : s;
  const whole = a / UNIT;
  const frac = (a % UNIT).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
};

export interface V2Link {
  /** The share link — link id in the path, metadata in the query, the secret in the #fragment. */
  link: string;
  /** The link id (the ephemeral key's 32-byte public key, hex) — the drop's on-chain key. */
  linkHex: string;
  hash: string;
}

/**
 * Deposit `amount` USDC behind a fresh link — GASLESS. The SENDER signs the invoke (authorizes the
 * USDC transfer into the escrow) but pays no gas: the sponsor FEE-BUMPS it via /v2-deposit, so even
 * a 0-XLM sender can create a link (proven: the gasless-deposit spike, 5/5).
 *
 * With `password`, the link key is DERIVED from a random seed plus that password instead of being
 * random (see ./claim-password.ts): the fragment then carries only half the key, so intercepting
 * the link is no longer enough to take the money. The escrow, the deposit and the reclaim path are
 * identical either way — only where the key comes from changes.
 */
export async function createV2Link(opts: {
  signer: Signer;
  amount: string;
  /** display name shown as "<from> sent you money" on the claim screen */
  from: string;
  webOrigin: string;
  sponsorUrl: string;
  /** unix seconds; default now + 7 days (the reclaim window) */
  expiry?: number;
  /** optional claim password — the recipient must know it before the money will move */
  password?: string;
}): Promise<V2Link> {
  // Resolved ONCE and reused for the transaction and the link's `n` label. Deriving it twice is
  // how the tx and the label could disagree, which would mint a link pointing at an escrow that
  // never received the money.
  const net = defaultNet();
  const server = new rpc.Server(net.rpcUrl);
  // No password ⇒ a random ephemeral key that IS the fragment (the fast default).
  // A password ⇒ a key derived from a random seed + the password; the seed is the fragment.
  const seed = opts.password ? makeLinkSeed() : null;
  const link = seed ? await deriveLinkKey(seed, opts.password!) : Keypair.random();
  const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");
  const sender = opts.signer.publicKey();
  const expiry = BigInt(opts.expiry ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600);

  const source = await server.getAccount(sender);
  const tx = new TransactionBuilder(source, { fee: "2000000", networkPassphrase: net.passphrase })
    .addOperation(
      new Contract(net.contract).call(
        "deposit",
        Address.fromString(sender).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
        nativeToScVal(usdcStroops(opts.amount), { type: "i128" }),
        nativeToScVal(expiry, { type: "u64" }),
      ),
    )
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`deposit simulation failed: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  await opts.signer.sign(prepared); // sender authorizes (source-account auth covers the SAC transfer)

  /* The instant this signed transaction stops being includable, and therefore the instant an empty
     escrow starts meaning anything. The sponsor gives up watching after ~60s while the tx keeps its
     full validity window, so "no drop yet" before this is still in flight, not a refusal. A tx
     without an upper bound would never reach that point. */
  const retrySafeAfter = Number(prepared.timeBounds?.maxTime ?? 0) * 1000 || Number.POSITIVE_INFINITY;

  // Gasless: the sponsor fee-bumps + submits the sender-signed inner (the sender pays no XLM).
  /* Assembled BEFORE the deposit is submitted. The link is a pure function of the key we just
     generated, so having it early costs nothing — and it means an unconfirmed deposit can still be
     handed to the user if the ledger later shows it landed. */
  const q = `a=${encodeURIComponent(opts.amount)}&s=${encodeURIComponent(opts.from)}${seed ? "&p=1" : ""}${net.isMainnet ? "&n=public" : ""}`;
  const fragment = seed ? passwordFragment(seed) : link.secret();
  const url = `${opts.webOrigin.replace(/\/$/, "")}/v2/c/${linkHex}?${q}#${fragment}`;

  const base = opts.sponsorUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/v2-deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr: prepared.toXDR(), senderPublicKey: sender }),
    });
  } catch {
    /* The connection dropped. A rejected fetch cannot tell us whether the request arrived — a phone
     * losing signal mid-flight looks identical to one that never sent — and the sponsor may have
     * submitted the deposit before we lost the reply. So we ask the escrow rather than assume the
     * convenient answer. */
    const landed = await v2DepositLanded(linkHex, sender);
    if (landed === true) return { link: url, linkHex, hash: "" };
    if (landed === "unknown" || Date.now() < retrySafeAfter)
      throw new DepositUncertainError(linkHex, url, retrySafeAfter);
    throw new Error("couldn't reach the sponsor");
  }
  /* Three outcomes, and conflating them is what lost money.
   *
   * 200 — the sponsor watched it land. Done.
   *
   * 202 — accepted by the ledger, not yet observed. NOT a failure. Ask the escrow directly; it is
   *       the only authority on whether this drop exists. If it does, the send succeeded and the
   *       user gets their link. An empty escrow only means "nothing moved" once the signed tx can
   *       no longer be included — until then it may still be in the queue, and a retry mints a
   *       SECOND drop under a fresh link key. If we cannot read the escrow either, we say so — and
   *       the caller must not offer a plain "try again".
   *
   * A rejected request (4xx/5xx) never reached the ledger, so those still throw normally: the
   * pilot gate, the caps and the anti-drain validator all answer before anything is submitted.
   */
  const text = await res.text();
  if (res.status === 202) {
    const landed = await v2DepositLanded(linkHex, sender);
    if (landed === "unknown" || (landed === false && Date.now() < retrySafeAfter))
      throw new DepositUncertainError(linkHex, url, retrySafeAfter);
    if (landed === false) throw new Error(`/v2-deposit → not submitted: ${text}`);
    // landed === true → it did happen; fall through and hand back the link.
  } else if (!res.ok) {
    throw new Error(`/v2-deposit → ${res.status}: ${text}`);
  }
  const { hash } = (text ? JSON.parse(text) : { hash: "" }) as { hash: string };

  // `p=1` lets the claim screen ask for the password BEFORE it reads the fragment, so a
  // recipient sees "this one needs the password" rather than a button that quietly fails.
  // `n=public` is what tells the RECIPIENT's device this is real money. resolveNetwork() treats a
  // missing `n` as testnet, so a mainnet link without it sent the claimer looking for the drop in
  // the testnet escrow, where it does not exist — the claim failed for a reason neither side could
  // see. The recipient arrives with no prior state (that is the whole point of the product), so the
  // network cannot come from their device; it has to travel in the link.
  return { link: url, linkHex, hash };
}

/**
 * Claim a v2 drop to `payout`, chosen NOW (late binding). Reads the exact message to sign from the
 * contract (parity), signs it with the link key, and asks the sponsor RELAYER to submit + pay the
 * fee. The `payout` account must already exist (a USDC trustline, or a contract account) so the
 * escrow's SAC transfer to it succeeds. Returns the claim tx hash.
 */
export async function claimV2(opts: {
  /** the S… link secret from the URL #fragment */
  linkSecret: string;
  /** the recipient's payout account (G… or C…) */
  payout: string;
  /** which network this link lives on; omit for testnet (the product default) */
  net?: NetworkConfig;
  sponsorUrl: string;
  /** true for a group-drop share (claim_share); false/undefined for a one-to-one claim */
  group?: boolean;
}): Promise<{ hash: string }> {
  const net = opts.net ?? defaultNet();
  const server = new rpc.Server(net.rpcUrl);
  const link = Keypair.fromSecret(opts.linkSecret);
  const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");
  const kind = opts.group ? 2 : 1;
  const method = opts.group ? "claim_share" : "claim";

  // Find the escrow that actually holds this drop — a link minted before a contract upgrade
  // still lives in the superseded one, and only that contract can release it.
  const contract = await resolveDropContract(server, opts.payout, linkHex, opts.group, net);

  // Read the EXACT bytes to sign from THAT contract (source = payout, which exists). The
  // message binds the contract address, so reading it from the wrong one yields a signature
  // the escrow would reject — this is why the resolution has to happen first. No submit.
  const src = await server.getAccount(opts.payout);
  const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: net.passphrase })
    .addOperation(
      new Contract(contract).call(
        "claim_message",
        nativeToScVal(kind, { type: "u32" }),
        xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
        Address.fromString(opts.payout).toScVal(),
      ),
    )
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(view);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`claim_message read failed: ${sim.error}`);
  const message = scValToNative((sim as rpc.Api.SimulateTransactionSuccessResponse).result!.retval) as Uint8Array;

  const sigHex = Buffer.from(link.sign(Buffer.from(message))).toString("hex");

  const base = (opts.sponsorUrl || net.sponsorUrl).replace(/\/$/, "");
  const res = await fetch(`${base}/v2-claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, linkHex, payout: opts.payout, sigHex, contract }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/v2-claim → ${res.status}: ${text}`);
  return JSON.parse(text) as { hash: string };
}


/**
 * What a claim attempt actually did. A discriminated result rather than a thrown Error, because
 * these three failures are the escrow's settled answer about the drop itself — the claim screen has
 * to name which one it is and must not offer a retry — while everything that CAN be retried (the
 * RPC, the relayer, a dropped connection) still arrives as a throw.
 */
export type V2ClaimOutcome =
  | { kind: "claimed"; hash: string; publicKey: string; seed: Uint8Array }
  | { kind: "already-claimed" }
  | { kind: "no-such-drop" }
  /** Group drops only: `claim_share` is refused from the expiry on, a one-to-one `claim` is not. */
  | { kind: "expired" };

/**
 * True when asking again cannot change the answer. A "claimed" outcome is not a retry question —
 * it already paid out — and every retryable failure reaches the caller as a thrown error instead.
 */
export function isTerminalClaimOutcome(o: V2ClaimOutcome): boolean {
  return o.kind !== "claimed";
}

/** A read-only simulation needs a source account, not an existing one — the SDK's impossible one. */
const NULL_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/**
 * Can this link still pay out? Asked of whichever escrow holds it, and asked BEFORE anything is
 * created for the claim.
 *
 * The order is the point. Creating the sponsored account first meant every tap on a dead link burnt
 * a sponsor reserve and filed an empty account into this device's keystore, which then costs a
 * balance read on every /home, /send and /account for as long as the device keeps it — so anyone
 * holding a spent link could run that up with the retry button.
 *
 * A read we could not finish is not "no such drop": it throws, so the caller keeps its retry.
 */
async function readClaimState(
  server: rpc.Server,
  linkHex: string,
  group: boolean,
  net: NetworkConfig,
): Promise<"claimable" | "already-claimed" | "no-such-drop" | "expired"> {
  const view = group ? "get_pool" : "get_drop";
  let unread = false;
  for (const contract of dropContracts(net)) {
    try {
      const tx = new TransactionBuilder(new Account(NULL_SOURCE, "0"), {
        fee: "1000000",
        networkPassphrase: net.passphrase,
      })
        .addOperation(new Contract(contract).call(view, xdr.ScVal.scvBytes(Buffer.from(linkHex, "hex"))))
        .setTimeout(60)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        unread = true;
        continue;
      }
      const val = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (!val) {
        unread = true;
        continue;
      }
      const d = scValToNative(val) as {
        claimed?: boolean | number;
        expiry?: bigint | number;
        slots?: number;
        remaining?: bigint;
        amount_per?: bigint;
      } | null;
      if (d == null) continue; // this escrow doesn't hold it ⇒ try the next
      if (!group) return d.claimed ? "already-claimed" : "claimable";
      // claim_share is the one entrypoint the contract refuses once expiry passes; a one-to-one
      // drop stays claimable until the sender reclaims it, and that is what sets `claimed`.
      if (Math.floor(Date.now() / 1000) >= Number(d.expiry ?? 0)) return "expired";
      const exhausted =
        Number(d.claimed ?? 0) >= Number(d.slots ?? 0) || (d.remaining ?? 0n) < (d.amount_per ?? 0n);
      return exhausted ? "already-claimed" : "claimable";
    } catch {
      unread = true; // unreachable escrow ⇒ try the next one
    }
  }
  // "No drop" only holds if EVERY escrow said so. One we could not reach may be the one holding the
  // money, and "your link is dead" is the one answer that must never be a guess.
  if (unread) throw new Error("couldn't read the escrow");
  return "no-such-drop";
}

/**
 * The walletless recipient path for the v2 UI: create a fresh account with a sponsored USDC
 * trustline (reusing the sponsor's /create-account — 0 XLM to the recipient), then claim the v2
 * drop straight into it via the relayer. On success the outcome carries the new account + seed to
 * persist locally.
 *
 * (A classic account needs a USDC trustline to hold the SAC balance — hence the sponsored
 * create-account; the trustline reserve is the sponsor's. The zero-reserve win fully lands once
 * the payout is a passkey smart-account contract, which holds the SAC with no trustline — v2.1.)
 */
export async function claimV2ToSponsoredAccount(opts: {
  linkSecret: string;
  sponsorUrl: string;
  /** which network this link lives on; omit for testnet (the product default) */
  net?: NetworkConfig;
  group?: boolean;
  /** Called once the payout account exists on-ledger, BEFORE the claim is relayed. */
  onAccountReady?: (publicKey: string, seed: Uint8Array) => Promise<void> | void;
}): Promise<V2ClaimOutcome> {
  const net = opts.net ?? defaultNet();
  const base = (opts.sponsorUrl || net.sponsorUrl).replace(/\/$/, "");
  const server = new rpc.Server(net.rpcUrl);
  const linkHex = Buffer.from(Keypair.fromSecret(opts.linkSecret).rawPublicKey()).toString("hex");

  // Everything below this line spends a sponsor reserve and leaves an account on this device. A
  // drop that can never pay out must cost neither, however many times the button is pressed.
  const state = await readClaimState(server, linkHex, Boolean(opts.group), net);
  if (state !== "claimable") return { kind: state };

  const horizon = new Horizon.Server(net.horizonUrl);
  const payout = Keypair.random();

  // 1. sponsor creates the account + USDC trustline (recipient holds 0 XLM); recipient co-signs.
  const created = (await (
    await fetch(`${base}/create-account`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipientPublicKey: payout.publicKey() }),
    })
  ).json()) as { xdr?: string; error?: string };
  if (!created.xdr) throw new Error(created.error ?? "create-account failed");
  const sandwich = TransactionBuilder.fromXDR(created.xdr, net.passphrase) as Transaction;
  assertSponsoredOnboarding(sandwich, payout.publicKey(), net.id);
  sandwich.sign(payout);
  await horizon.submitTransaction(sandwich);

  /* The account exists on-ledger now, so the caller gets the key BEFORE the money is sent to it.
   *
   * The old order persisted only after a successful claim, which meant a dropped connection during
   * the claim — a phone on a Turkish mobile network, the exact user this product is for — left the
   * money sitting in an account whose only key had just gone out of scope. The claim relayer polls
   * for up to a minute, so that window is real, not theoretical. Saving first costs nothing if the
   * claim then fails: an empty sponsored account is harmless. */
  await opts.onAccountReady?.(payout.publicKey(), new Uint8Array(payout.rawSecretKey()));

  // 2. claim the v2 drop into the new account via the relayer (walletless + gasless).
  const { hash } = await claimV2({
    linkSecret: opts.linkSecret,
    payout: payout.publicKey(),
    sponsorUrl: base,
    net,
    group: opts.group,
  });
  return { kind: "claimed", hash, publicKey: payout.publicKey(), seed: new Uint8Array(payout.rawSecretKey()) };
}

/* -------------------------- v2 reclaim (C2 recovery) -------------------------- */

export interface ReclaimableV2 {
  /** the drop id (32-byte link public key, hex) — pass to reclaimV2 */
  linkHex: string;
  usd: string;
  /** unix seconds the reclaim window opened (already past for a reclaimable drop) */
  expiry: number;
}

/** Read a drop's on-chain state from ONE contract via its get_drop view (read-only simulation). */
async function readDropFrom(
  server: rpc.Server,
  sourceAccount: string,
  linkHex: string,
  contract: string,
  net: NetworkConfig,
): Promise<{ amount: bigint; expiry: number; claimed: boolean } | null> {
  const src = await server.getAccount(sourceAccount);
  const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: net.passphrase })
    .addOperation(new Contract(contract).call("get_drop", xdr.ScVal.scvBytes(Buffer.from(linkHex, "hex"))))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(view);
  if (rpc.Api.isSimulationError(sim)) return null;
  const val = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!val) return null;
  const d = scValToNative(val) as { amount?: bigint; expiry?: bigint | number; claimed?: boolean } | null;
  if (!d) return null; // None ⇒ this contract doesn't hold the drop (or it's already gone)
  return { amount: BigInt(d.amount ?? 0n), expiry: Number(d.expiry ?? 0), claimed: !!d.claimed };
}

/** Read a drop from whichever escrow holds it (current first, then superseded ones). */
async function readDrop(
  server: rpc.Server,
  sourceAccount: string,
  linkHex: string,
  net: NetworkConfig,
): Promise<({ amount: bigint; expiry: number; claimed: boolean } & { contract: string }) | null> {
  for (const contract of dropContracts(net)) {
    try {
      const d = await readDropFrom(server, sourceAccount, linkHex, contract, net);
      if (d) return { ...d, contract };
    } catch {
      /* unreachable contract ⇒ try the next one */
    }
  }
  return null;
}

/**
 * Did a deposit for this link actually reach the escrow?
 *
 * The one question that decides whether it is safe to send again, so it answers in three values and
 * never guesses. `readDrop` cannot be reused here: it swallows per-contract errors and returns null,
 * which conflates "no such drop" with "could not ask" — and treating the second as the first is
 * precisely how a user gets told to retry a deposit that already landed.
 *
 * A link key is freshly random per attempt, so for THIS link "no drop" is unambiguous: the money
 * did not move. Anything that stops us reading is "unknown", which is a real answer, not a failure.
 */
export async function v2DepositLanded(
  linkHex: string,
  sourceAccount: string,
): Promise<boolean | "unknown"> {
  const net = defaultNet();
  const server = new rpc.Server(net.rpcUrl);
  try {
    const src = await server.getAccount(sourceAccount);
    const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: net.passphrase })
      .addOperation(
        new Contract(net.contract).call("get_drop", xdr.ScVal.scvBytes(Buffer.from(linkHex, "hex"))),
      )
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(view);
    if (rpc.Api.isSimulationError(sim)) return "unknown";
    const val = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!val) return "unknown";
    // A successful simulation that returns None is a definitive "this link holds nothing".
    return scValToNative(val) != null;
  } catch {
    return "unknown";
  }
}

/**
 * Thrown when a deposit could not be confirmed. `landed` carries what we actually established, so
 * the UI can tell the truth instead of asserting the comfortable thing.
 */
export class DepositUncertainError extends Error {
  constructor(
    readonly linkHex: string,
    /** The claim URL this attempt would produce. Carried because the deposit may yet land, and a
     *  recipient cannot be paid with a drop whose link we threw away. */
    readonly link: string,
    /** Unix ms after which the signed deposit can no longer be included, so an empty escrow is at
     *  last proof that nothing moved. A re-check before this can only ever answer "not yet"; only
     *  past it may the UI offer to send again. */
    readonly retrySafeAfter: number,
  ) {
    super("deposit submitted but not confirmed");
    this.name = "DepositUncertainError";
  }
}

/**
 * Has this v2 link been claimed yet? The counterpart to `loadLinkStatus` for the CLASSIC path.
 *
 * They cannot share a reader: a classic Claimable Balance id is 72 hex and lives on Horizon, while
 * a v2 drop id is the 64-hex link pubkey and lives in the Soroban escrow. Asking Horizon about a
 * 64-hex id does not 404, it **400s** ("does not validate as claimableBalanceID"), so the sender's
 * "is it claimed yet?" read threw on every single v2 send — and the caller's catch defaulted to
 * "pending". Every link a sender ever made read "Still waiting to be claimed" forever, including
 * seconds after the recipient had the money.
 *
 * `unknown` is a real third answer, not a failure dressed as one: a read we could not complete must
 * never be reported as a settled or an outstanding payment.
 */
export async function loadV2DropStatus(
  linkHex: string,
  sourceAccount: string,
): Promise<"pending" | "settled" | "unknown"> {
  try {
    const net = defaultNet();
    const server = new rpc.Server(net.rpcUrl);
    const drop = await readDrop(server, sourceAccount, linkHex, net);
    // No escrow holds it ⇒ it has been claimed or reclaimed and cleared — the same conclusion the
    // classic path draws from a 404.
    if (!drop) return "settled";
    return drop.claimed ? "settled" : "pending";
  } catch {
    return "unknown";
  }
}

/**
 * Which escrow holds this link? Returns the current contract when nothing is found, so a caller
 * still produces a normal on-chain error rather than a confusing client-side one. A group drop
 * lives under `get_pool`, so the probe follows the drop kind.
 */
async function resolveDropContract(
  server: rpc.Server,
  sourceAccount: string,
  linkHex: string,
  group?: boolean,
  net: NetworkConfig = defaultNet(),
): Promise<string> {
  const candidates = dropContracts(net);
  if (candidates.length === 1) return net.contract;
  const view = group ? "get_pool" : "get_drop";
  for (const contract of candidates) {
    try {
      const src = await server.getAccount(sourceAccount);
      const tx = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: net.passphrase })
        .addOperation(new Contract(contract).call(view, xdr.ScVal.scvBytes(Buffer.from(linkHex, "hex"))))
        .setTimeout(60)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) continue;
      const val = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
      if (val && scValToNative(val) != null) return contract;
    } catch {
      /* try the next contract */
    }
  }
  return net.contract;
}

/**
 * Your v2 sends that have come back: local `lumenia.sent` records whose drop is still on-chain,
 * UNCLAIMED, and past its expiry — so you can reclaim them gaslessly (reclaimV2). Reads
 * get_drop(link) per record (a read-only simulation); classic-CB ids (not 64-hex link keys) are
 * skipped, so this never double-counts the classic Horizon path (loadReclaimableSends).
 * `sender` is the user's home account (an existing account is needed as the simulation source).
 */
export async function loadReclaimableV2(sender: string): Promise<ReclaimableV2[]> {
  const net = defaultNet();
  let records: Record<string, { balanceId?: string }>;
  try {
    records = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as Record<string, { balanceId?: string }>;
  } catch {
    return [];
  }
  const linkHexes = Array.from(
    new Set(
      Object.values(records)
        .map((r) => r.balanceId)
        .filter((b): b is string => typeof b === "string" && /^[0-9a-f]{64}$/i.test(b)),
    ),
  );
  if (linkHexes.length === 0) return [];
  const server = new rpc.Server(net.rpcUrl);
  const nowSec = Math.floor(Date.now() / 1000);
  // Parallel per-drop reads (bounded by the local send count) so the bell poll stays light.
  const results = await Promise.all(
    linkHexes.map(async (linkHex): Promise<ReclaimableV2 | null> => {
      try {
        const drop = await readDrop(server, sender, linkHex, net);
        if (drop && !drop.claimed && nowSec >= drop.expiry && drop.amount > 0n) {
          return { linkHex, usd: stroopsToUsdc(drop.amount), expiry: drop.expiry };
        }
      } catch {
        /* unreadable / archived ⇒ skip (it isn't reclaimable right now) */
      }
      return null;
    }),
  );
  return results.filter((r): r is ReclaimableV2 => r !== null);
}

/**
 * Reclaim your OWN unclaimed v2 drop after its expiry — GASLESS. You sign the reclaim(link)
 * invoke (the contract does sender.require_auth, satisfied by source-account auth); the sponsor
 * FEE-BUMPS it via /v2-reclaim so you pay no gas. Your USDC returns to you. Proven: spike10.
 */
export async function reclaimV2(opts: {
  signer: Signer;
  linkHex: string;
  sponsorUrl: string;
  /** true for a group drop (reclaim_pool); false/undefined for a one-to-one drop (reclaim) */
  group?: boolean;
}): Promise<{ hash: string }> {
  const net = defaultNet();
  const server = new rpc.Server(net.rpcUrl);
  const sender = opts.signer.publicKey();
  const method = opts.group ? "reclaim_pool" : "reclaim";
  // Your own money can be sitting in a superseded escrow — reclaim from wherever it is.
  const contract = await resolveDropContract(server, sender, opts.linkHex, opts.group);
  const source = await server.getAccount(sender);
  const tx = new TransactionBuilder(source, { fee: "2000000", networkPassphrase: net.passphrase })
    .addOperation(new Contract(contract).call(method, xdr.ScVal.scvBytes(Buffer.from(opts.linkHex, "hex"))))
    .setTimeout(120)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`reclaim simulation failed: ${sim.error}`);
  const prepared = rpc.assembleTransaction(tx, sim).build();
  await opts.signer.sign(prepared); // sender authorizes (source-account auth); sponsor fee-bumps

  const base = opts.sponsorUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v2-reclaim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xdr: prepared.toXDR(), senderPublicKey: sender }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/v2-reclaim → ${res.status}: ${text}`);
  return JSON.parse(text) as { hash: string };
}
