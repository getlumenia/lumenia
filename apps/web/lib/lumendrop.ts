/**
 * v2 client — the browser side of the deployed LumenDrop Soroban escrow (RECOVERY/§ V2 doc).
 * The v2 primitive: the link key doesn't hold the money — it authorizes a payout chosen AT CLAIM
 * TIME. So there is no per-recipient reserve, no throwaway-account fragmentation, and no sweep.
 *
 *   createV2Link — a sender deposits USDC behind a fresh ephemeral link key (Soroban invoke).
 *   claimV2      — a recipient picks a payout NOW, the link key signs it, and the sponsor RELAYER
 *                  submits the claim + pays the Soroban fee (walletless + gasless). Proven on-chain
 *                  (7/7) + the relayer path is exercised against the live contract.
 *   createV2GroupLink - the same link carrying a POT of N equal shares (create_drop / claim_share /
 *                  reclaim_pool). One link, many claimants, one share each into their own account.
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
import { resolveNetwork, activeNetwork, USDC_ISSUER, type NetworkConfig } from "./network";
import { deriveLinkKey, makeLinkSeed, passwordFragment } from "./claim-password";
import { assertSponsoredOnboarding } from "./tx-guard";
/* The relayer's contract-error tokens are read in exactly one place. A resumed group claim coming
   back "this payout already has a share" is a SUCCESS wearing a failure's clothes, and the classifier
   is what knows the difference. (No cycle: claim-error.ts imports nothing from here.) */
import { classifyClaimError } from "./claim-error";

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

/* ---------------------------- group links: a pot of equal shares ----------------------------
 * A group link is the same link carrying a POOL instead of a single drop: `create_drop` escrows one
 * pot of N equal shares, and each claimant takes exactly one into their own fresh sponsored account.
 *
 * What the ledger actually guarantees, and the only thing to say out loud: at most N shares, exactly
 * `amount_per` each, only to an address the link signed for, and nothing at all after the deadline.
 * NOT one share per person - the contract keys uniqueness on the PAYOUT ADDRESS, and addresses are
 * free. The shared word keeps strangers out; it does not make anyone unique.
 *
 * Pool and Drop are SEPARATE storage maps under the same link key, so the claim path asks the escrow
 * which one holds a link rather than believing the `g` hint in the URL (see readClaimState).
 */

/** Pool bounds, mirroring the sponsor relay's own refusal (apps/sponsor/src/lib/soroban-relay.ts). */
export const MIN_POOL_SLOTS = 2;
export const MAX_POOL_SLOTS = 30;
/* REAL MONEY: mainnet pools are bounded far tighter than practice ones, because every share
   claimed opens a sponsored account out of a float measured in tens of onboardings. The sponsor
   enforces the same six and refuses to read anything above eight, whatever its configuration says;
   this is the copy of that number the screen can show BEFORE the sender signs. */
export const MAINNET_MAX_POOL_SLOTS = 6;

/** The ceiling that applies on a given network. */
export function maxPoolSlots(isMainnet: boolean): number {
  return isMainnet ? MAINNET_MAX_POOL_SLOTS : MAX_POOL_SLOTS;
}

/** Which escrow holds a link. The URL's `g` is a hint; only the escrow gives an answer. */
export type V2LinkKind = "single" | "group";

/**
 * Read the `g` hint - how many shares the link SAYS it holds.
 *
 * Anything that is not a whole number inside the bounds is ignored rather than clamped: the query is
 * writable by anyone who forwards the link, and a clamped value would print a share count the escrow
 * never agreed to. The hint only decides which view is probed first and what the page renders while
 * it waits; it never decides what gets signed.
 */
export function parseSlots(raw: string | string[] | null | undefined): number | null {
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (typeof one !== "string") return null;
  const trimmed = one.trim();
  // Digits only. `Number()` alone would read "0x3" and "3e0" as 3, and a share count that depends on
  // how JavaScript parses a string is not a share count.
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= MIN_POOL_SLOTS && n <= MAX_POOL_SLOTS ? n : null;
}

/**
 * Split the `g` copy that rides in the #fragment off the key material.
 *
 * The count travels twice on purpose: chat apps trim query strings and leave fragments intact, and a
 * claimant whose `?g` was trimmed would otherwise be told by the get_drop probe that the link is
 * empty. `g` is not a secret - it is the share count already printed on the page.
 *
 * EVERY reader of a claim fragment must pass it through here BEFORE lib/claim-password.ts sees it:
 * that parser treats the whole fragment as the key, so an unsplit `S...&g=6` is simply a bad secret.
 */
export function splitGroupHint(fragment: string): { slots: number | null; fragment: string } {
  const frag = fragment.replace(/^#/, "");
  const m = frag.match(/&g=(\d{1,3})(?![0-9])/);
  if (!m) return { slots: null, fragment: frag };
  return { slots: parseSlots(m[1]), fragment: frag.replace(m[0], "") };
}

/**
 * The exact pot for `slots` shares of `perShare`.
 *
 * The contract floor-divides `amount / slots`, so a pot that is not an exact multiple leaves dust
 * that nobody can claim and that sits there until the sender takes it back. Multiplying in stroops is
 * the only way to stay exact; a float reintroduces the dust this is here to avoid.
 */
export function groupTotal(perShare: string, slots: number): string {
  return stroopsToUsdc(usdcStroops(perShare) * BigInt(slots));
}

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
  /**
   * The team funded this link for the event ("try it with $2 from us"). Adds a public `seeded=1`
   * marker to the link's query (never the fragment) so the claim beacons are counted apart and
   * never as sender adoption. Public on purpose: the marker is honest, not hidden.
   */
  seeded?: boolean;
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
  // Sender authorizes (source-account auth covers the SAC transfer). The transaction the signer
  // RETURNS is the one that goes on the wire: a local key signs in place, but an external wallet
  // (lib/wallets-kit.ts) signs a copy it received as XDR, and the copy is where the signature is.
  const prepared = await opts.signer.sign(rpc.assembleTransaction(tx, sim).build());

  /* The instant this signed transaction stops being includable, and therefore the instant an empty
     escrow starts meaning anything. The sponsor gives up watching after ~60s while the tx keeps its
     full validity window, so "no drop yet" before this is still in flight, not a refusal. A tx
     without an upper bound would never reach that point. */
  const retrySafeAfter = Number(prepared.timeBounds?.maxTime ?? 0) * 1000 || Number.POSITIVE_INFINITY;

  // Gasless: the sponsor fee-bumps + submits the sender-signed inner (the sender pays no XLM).
  /* Assembled BEFORE the deposit is submitted. The link is a pure function of the key we just
     generated, so having it early costs nothing — and it means an unconfirmed deposit can still be
     handed to the user if the ledger later shows it landed. */
  // `s=` is the sender's display name, so the seeded marker is spelled out as `seeded=1`.
  const q = `a=${encodeURIComponent(opts.amount)}&s=${encodeURIComponent(opts.from)}${seed ? "&p=1" : ""}${net.isMainnet ? "&n=public" : ""}${opts.seeded ? "&seeded=1" : ""}`;
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
 * Escrow a POT of `slots` equal shares behind a fresh link - one link, many claimants, and none of
 * them pays gas. Same escrow, same relayer, same fee-bump as `createV2Link`; the entrypoint is
 * `create_drop` and the record it writes is a Pool.
 *
 * Deliberately a separate function rather than a flag on `createV2Link`. The single-link path is the
 * live money loop every /send hands out today, and the two differ in the escrow view they must ask
 * about an unconfirmed deposit (get_pool vs get_drop) - a shared body would have to branch on that in
 * three places, and getting it wrong means telling a sender "nothing moved" about a pot that did.
 */
export async function createV2GroupLink(opts: {
  signer: Signer;
  /** what ONE claimant takes, as a decimal string; the pot is this times `slots`, exactly */
  perShare: string;
  /** how many equal shares, 2..MAX_POOL_SLOTS */
  slots: number;
  /** display name shown as "<from> sent you money" on the claim screen */
  from: string;
  webOrigin: string;
  sponsorUrl: string;
  /** unix seconds the link closes; after it, only the sender can take the leftover back */
  expiry?: number;
  /** optional shared word - everyone claiming has to know it before the money will move */
  password?: string;
  /** the team funded this pot for the event; marks the claims so they are never counted as adoption */
  seeded?: boolean;
}): Promise<V2Link & { perShare: string; slots: number; total: string }> {
  const net = defaultNet();
  /* REAL MONEY: mainnet pools are open (owner decision, 2026-09-20) and bounded rather than
     refused. Three things hold them: the per-transfer cap binds the POT and not the share, the
     per-share floor stops a cent buying a row of sponsored accounts, and the seat ceiling below
     bounds the reserve one link can mortgage. The sponsor enforces every one of them again on its
     own side, which is the half an attacker cannot skip by opening the screen anyway. */
  const ceiling = maxPoolSlots(net.isMainnet);
  if (!Number.isInteger(opts.slots) || opts.slots < MIN_POOL_SLOTS || opts.slots > ceiling) {
    throw new Error(`A group link holds between ${MIN_POOL_SLOTS} and ${ceiling} shares.`);
  }

  const server = new rpc.Server(net.rpcUrl);
  const seed = opts.password ? makeLinkSeed() : null;
  const link = seed ? await deriveLinkKey(seed, opts.password!) : Keypair.random();
  const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");
  const sender = opts.signer.publicKey();
  const expiry = BigInt(opts.expiry ?? Math.floor(Date.now() / 1000) + 24 * 3600);
  // Exact multiple of the share, so the contract's floor division leaves nothing behind.
  const total = groupTotal(opts.perShare, opts.slots);

  const source = await server.getAccount(sender);
  const tx = new TransactionBuilder(source, { fee: "2000000", networkPassphrase: net.passphrase })
    .addOperation(
      // Contract order: (from, link, amount, slots, expiry). `amount` is the WHOLE pot.
      new Contract(net.contract).call(
        "create_drop",
        Address.fromString(sender).toScVal(),
        xdr.ScVal.scvBytes(Buffer.from(link.rawPublicKey())),
        nativeToScVal(usdcStroops(total), { type: "i128" }),
        nativeToScVal(opts.slots, { type: "u32" }),
        nativeToScVal(expiry, { type: "u64" }),
      ),
    )
    .setTimeout(120)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`group deposit simulation failed: ${sim.error}`);
  const prepared = await opts.signer.sign(rpc.assembleTransaction(tx, sim).build());
  const retrySafeAfter = Number(prepared.timeBounds?.maxTime ?? 0) * 1000 || Number.POSITIVE_INFINITY;

  /* `a=` is what ONE person takes - it is the figure the claim screen puts at 60px, and the claimant
     never receives the pot. `g=` is the share count, and it rides in the fragment as well as the
     query: chat apps trim queries and keep fragments, and a claimant who arrives with neither hint
     would have the pool probed second. */
  /* `n=public` is not decoration: resolveNetwork() reads a link with no network marker as practice
     money, so a mainnet pool without it would reach every claimant labelled as practice AND send
     their device looking for the pool in the testnet escrow, where it does not exist. The one-to-one
     link has carried it since the first mainnet send (line 241); a pool has to carry it too. */
  const q = `a=${encodeURIComponent(opts.perShare)}&s=${encodeURIComponent(opts.from)}&g=${opts.slots}${seed ? "&p=1" : ""}${net.isMainnet ? "&n=public" : ""}${opts.seeded ? "&seeded=1" : ""}`;
  const fragment = `${seed ? passwordFragment(seed) : link.secret()}&g=${opts.slots}`;
  const url = `${opts.webOrigin.replace(/\/$/, "")}/v2/c/${linkHex}?${q}#${fragment}`;
  const made = { link: url, linkHex, perShare: opts.perShare, slots: opts.slots, total };

  const base = opts.sponsorUrl.replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${base}/v2-deposit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xdr: prepared.toXDR(), senderPublicKey: sender }),
    });
  } catch {
    /* Same three-valued answer as the single-link path, asked of get_pool. A retry that mints a
       SECOND pot escrows the whole amount twice, so "we could not tell" must never become "try
       again" until the signed transaction can no longer be included. */
    const landed = await v2DepositLanded(linkHex, sender, { group: true });
    if (landed === true) return { ...made, hash: "" };
    if (landed === "unknown" || Date.now() < retrySafeAfter)
      throw new DepositUncertainError(linkHex, url, retrySafeAfter);
    throw new Error("couldn't reach the sponsor");
  }
  const text = await res.text();
  if (res.status === 202) {
    const landed = await v2DepositLanded(linkHex, sender, { group: true });
    if (landed === "unknown" || (landed === false && Date.now() < retrySafeAfter))
      throw new DepositUncertainError(linkHex, url, retrySafeAfter);
    if (landed === false) throw new Error(`/v2-deposit → not submitted: ${text}`);
  } else if (!res.ok) {
    throw new Error(`/v2-deposit → ${res.status}: ${text}`);
  }
  const { hash } = (text ? JSON.parse(text) : { hash: "" }) as { hash: string };
  return { ...made, hash };
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
  /**
   * True for a group-drop share (claim_share); false/undefined for a one-to-one claim.
   *
   * This must be what the ESCROW answered, never what the link's `?g` said. It picks the
   * domain-separation tag folded into the signed message (TAG_GROUP = kind 2), and the contract
   * silently reads any other kind as TAG_SINGLE - so a wrong value here signs bytes the pool will
   * reject, after a sponsored account has already been paid for.
   */
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
  | {
      kind: "claimed";
      hash: string;
      publicKey: string;
      /**
       * The payout's secret, for the caller to persist. EMPTY on a RESUMED claim: that key was
       * already handed to `onAccountReady` and saved on the first attempt, and this path never mints
       * a second one. Callers zero it and rely on the callback, which is the only place a seed is
       * handed out.
       */
      seed: Uint8Array;
      link: V2LinkKind;
    }
  /**
   * The escrow says THIS device's payout address already holds a share of this pool - the first
   * attempt landed and its answer was lost on the way back. The money is theirs and it is on this
   * phone; this is the one settled answer that may say where the money is, because the contract
   * keyed it to an address only this device has.
   */
  | { kind: "already-yours"; publicKey: string; link: V2LinkKind }
  | { kind: "already-claimed"; link: V2LinkKind }
  | { kind: "no-such-drop"; link: V2LinkKind }
  /** Group drops only: `claim_share` is refused from the expiry on, a one-to-one `claim` is not. */
  | { kind: "expired"; link: V2LinkKind };

/**
 * True when asking again cannot change the answer. A "claimed" outcome is not a retry question —
 * it already paid out — and every retryable failure reaches the caller as a thrown error instead.
 */
export function isTerminalClaimOutcome(o: V2ClaimOutcome): boolean {
  return o.kind !== "claimed";
}

/** A read-only simulation needs a source account, not an existing one — the SDK's impossible one. */
const NULL_SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

/** A link id is the 32-byte link public key. Anything else is not a drop in any escrow. */
const isLinkHex = (s: string): boolean => /^[0-9a-f]{64}$/i.test(s);

/**
 * Read ONE view on ONE escrow (read-only simulation). Three answers, kept apart on purpose:
 *
 *   a record  - this escrow holds the link
 *   null      - this escrow answered, and holds nothing
 *   a throw   - we could not ask
 *
 * Collapsing the last two into null is exactly how an unreachable RPC once reported itself as a
 * settled payment. Every caller here decides what to do with a throw; none of them may guess.
 */
async function readView<T>(
  server: rpc.Server,
  contract: string,
  view: "get_drop" | "get_pool",
  linkHex: string,
  net: NetworkConfig,
  sourceAccount?: string,
): Promise<T | null> {
  const src = sourceAccount ? await server.getAccount(sourceAccount) : new Account(NULL_SOURCE, "0");
  const tx = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: net.passphrase })
    .addOperation(new Contract(contract).call(view, xdr.ScVal.scvBytes(Buffer.from(linkHex, "hex"))))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${view} could not be read`);
  const val = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!val) throw new Error(`${view} returned nothing`);
  // A successful simulation returning None is a definitive "this escrow holds nothing for this link".
  return (scValToNative(val) as T | null) ?? null;
}

/** The Pool record as the contract stores it. No `amount` field: the pot is not carried anywhere. */
interface PoolRecord {
  sender: string;
  amount_per: bigint;
  remaining: bigint;
  slots: number;
  claimed: number;
  expiry: bigint | number;
}

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
  groupHint: boolean,
  net: NetworkConfig,
): Promise<{
  state: "claimable" | "already-claimed" | "no-such-drop" | "expired";
  kind: V2LinkKind;
}> {
  /* WHICH ESCROW IS ASKED, and why the order matters.
   *
   * Drop and Pool are separate storage maps under the same link key, and anyone who has seen a link
   * knows its id - so either kind can be shadowed by a cheap record of the other kind under the same
   * id. When the link says `g`, the pool is the authority and there is no fallback: a claimant whose
   * query was trimmed by a chat app still carries `g` in the fragment, and believing a shadow drop
   * would spend a sponsored account and then sign TAG_SINGLE bytes the pool rejects.
   *
   * With no hint at all, the single drop is asked first (the overwhelming majority of links) and the
   * pool second, so a trimmed group link still resolves instead of reading as empty. */
  const views: { view: "get_drop" | "get_pool"; kind: V2LinkKind }[] = groupHint
    ? [{ view: "get_pool", kind: "group" }]
    : [
        { view: "get_drop", kind: "single" },
        { view: "get_pool", kind: "group" },
      ];
  let unread = false;
  const nowSec = Math.floor(Date.now() / 1000);
  for (const { view, kind } of views) {
    for (const contract of dropContracts(net)) {
      try {
        const d = await readView<{
          claimed?: boolean | number;
          expiry?: bigint | number;
          slots?: number;
          remaining?: bigint;
          amount_per?: bigint;
        }>(server, contract, view, linkHex, net);
        if (d == null) continue; // this escrow doesn't hold it => try the next
        if (kind === "single") return { state: d.claimed ? "already-claimed" : "claimable", kind };
        // claim_share is the one entrypoint the contract refuses once expiry passes; a one-to-one
        // drop stays claimable until the sender reclaims it, and that is what sets `claimed`.
        // Expiry is checked first because the contract checks it first: past it, an exhausted pool
        // and a pool still holding money are refused identically, and "expired" is true of both.
        if (nowSec >= Number(d.expiry ?? 0)) return { state: "expired", kind };
        const exhausted =
          Number(d.claimed ?? 0) >= Number(d.slots ?? 0) || (d.remaining ?? 0n) < (d.amount_per ?? 0n);
        return { state: exhausted ? "already-claimed" : "claimable", kind };
      } catch {
        unread = true; // unreachable escrow => try the next one
      }
    }
  }
  // "No drop" only holds if EVERY escrow said so. One we could not reach may be the one holding the
  // money, and "your link is dead" is the one answer that must never be a guess.
  if (unread) throw new Error("couldn't read the escrow");
  return { state: "no-such-drop", kind: groupHint ? "group" : "single" };
}

/* --------------------------- the device latch (one claim per link) ---------------------------
 * What this phone already asked for, per link. It is the only record that survives a lost response,
 * and a pool is where losing one costs somebody else their share: the relayer gives up watching
 * after ~60s while the transaction stays includable, so an attempt that really landed can come back
 * as a failure. A retry that minted a FRESH payout would present an address the contract's per-payout
 * dedupe has never seen, and the pool would pay this person twice and starve the last claimant.
 *
 * `attempted` is written before the claim is relayed and asserts NOTHING about where the money is.
 * `taken` is written only after a confirmed hash. The difference is the whole point: a screen may
 * say "it's yours" off `taken`, and must go and look before saying anything off `attempted`.
 *
 * NOT netKey(): a first-time claimant's device flag says practice until a mainnet claim lands and
 * flips it, so a network-scoped key would move under the latch on the very next render. A link id is
 * a 32-byte public key and is already unique across networks.
 */
const latchKey = (linkHex: string): string => `lumenia.v2claim.${linkHex.toLowerCase()}`;

export interface ClaimLatch {
  /** `attempted`: we asked and never saw the answer. `taken`: we saw the money land. */
  state: "attempted" | "taken";
  /** the payout account this device already asked the escrow to pay - the contract's dedupe key */
  payout: string;
  /** which escrow answered, so a resume signs the same tag it signed the first time */
  link: V2LinkKind;
  /** unix ms */
  at: number;
}

/** What this device already asked for on this link, or null. Blocked storage answers null. */
export function readClaimLatch(linkHex: string): ClaimLatch | null {
  try {
    const raw = localStorage.getItem(latchKey(linkHex));
    if (!raw) return null;
    const l = JSON.parse(raw) as ClaimLatch;
    if (typeof l?.payout !== "string" || (l.state !== "attempted" && l.state !== "taken")) return null;
    // Anything but an explicit "group" reads as a single link: the group branch is the one that
    // changes what gets signed, and it may only be taken on a record that actually says so.
    return { ...l, link: l.link === "group" ? "group" : "single" };
  } catch {
    /* blocked storage or a record we can't read - never a reason to refuse a claim */
    return null;
  }
}

function writeClaimLatch(linkHex: string, latch: ClaimLatch): void {
  try {
    localStorage.setItem(latchKey(linkHex), JSON.stringify(latch));
  } catch {
    /* private mode, a locked-down webview. The claim still runs; it just loses its guard. */
  }
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
  /**
   * What the LINK said (`?g`, or the `&g=` copy in the fragment). A hint that decides which escrow
   * view is asked first and nothing else - the escrow's own answer decides what gets signed.
   */
  group?: boolean;
  /** Called once the payout account exists on-ledger, BEFORE the claim is relayed. */
  onAccountReady?: (publicKey: string, seed: Uint8Array) => Promise<void> | void;
}): Promise<V2ClaimOutcome> {
  const net = opts.net ?? defaultNet();
  const base = (opts.sponsorUrl || net.sponsorUrl).replace(/\/$/, "");
  const server = new rpc.Server(net.rpcUrl);
  const linkHex = Buffer.from(Keypair.fromSecret(opts.linkSecret).rawPublicKey()).toString("hex");

  /* A confirmed claim, before any request leaves this phone. `taken` is only ever written after a
     hash came back, so this is a fact about this device, not a guess about the money.
     Group links only: a single link that was already claimed keeps the answer it has always given,
     which names the take-back it cannot rule out (see settledCopy on the claim screen). */
  const latch = readClaimLatch(linkHex);
  if (latch?.state === "taken" && latch.link === "group") {
    return { kind: "already-yours", publicKey: latch.payout, link: latch.link };
  }

  /* Everything below this line spends a sponsor reserve and leaves an account on this device. A
     drop that can never pay out must cost neither, however many times the button is pressed - and
     the answer carries WHICH escrow replied, because that is what the signature is bound to. */
  const { state, kind } = await readClaimState(server, linkHex, Boolean(opts.group), net);
  if (state !== "claimable") return { kind: state, link: kind };

  /* RESUME rather than a second claim. Reusing the payout this device already presented makes a
     retry idempotent at the contract: it either lands, or the pool answers "this address already has
     one" - which is the truth, and is this person's own share. The account already exists, so the
     sponsored create is skipped and no second reserve is spent. */
  let payout: Keypair | null = null;
  let payoutPublic = latch?.payout ?? "";
  if (!payoutPublic) {
    payout = Keypair.random();
    payoutPublic = payout.publicKey();
    const horizon = new Horizon.Server(net.horizonUrl);

    // 1. sponsor creates the account + USDC trustline (recipient holds 0 XLM); recipient co-signs.
    const created = (await (
      await fetch(`${base}/create-account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recipientPublicKey: payoutPublic }),
      })
    ).json()) as { xdr?: string; error?: string };
    if (!created.xdr) throw new Error(created.error ?? "create-account failed");
    const sandwich = TransactionBuilder.fromXDR(created.xdr, net.passphrase) as Transaction;
    assertSponsoredOnboarding(sandwich, payoutPublic, net.id);
    sandwich.sign(payout);
    await horizon.submitTransaction(sandwich);

    /* The account exists on-ledger now, so the caller gets the key BEFORE the money is sent to it.
     *
     * The old order persisted only after a successful claim, which meant a dropped connection during
     * the claim - a phone on a Turkish mobile network, the exact user this product is for - left the
     * money sitting in an account whose only key had just gone out of scope. The claim relayer polls
     * for up to a minute, so that window is real, not theoretical. Saving first costs nothing if the
     * claim then fails: an empty sponsored account is harmless. */
    await opts.onAccountReady?.(payoutPublic, new Uint8Array(payout.rawSecretKey()));
  }

  // The guard goes down BEFORE the relay, because the response is the thing that gets lost.
  writeClaimLatch(linkHex, { state: "attempted", payout: payoutPublic, link: kind, at: Date.now() });

  // 2. claim the v2 drop into the new account via the relayer (walletless + gasless).
  let hash = "";
  try {
    hash = (
      await claimV2({
        linkSecret: opts.linkSecret,
        payout: payoutPublic,
        sponsorUrl: base,
        net,
        group: kind === "group",
      })
    ).hash;
  } catch (e) {
    /* The pool says this exact payout already holds a share. Only this device has that address, so
       this is not a guess: the earlier attempt landed and its answer was lost. */
    if (classifyClaimError(e).kind === "already-yours") {
      writeClaimLatch(linkHex, { state: "taken", payout: payoutPublic, link: kind, at: Date.now() });
      return { kind: "already-yours", publicKey: payoutPublic, link: kind };
    }
    throw e;
  }
  writeClaimLatch(linkHex, { state: "taken", payout: payoutPublic, link: kind, at: Date.now() });
  return {
    kind: "claimed",
    hash,
    publicKey: payoutPublic,
    // Empty on a resume: that key was handed to onAccountReady and saved on the first attempt.
    seed: payout ? new Uint8Array(payout.rawSecretKey()) : new Uint8Array(0),
    link: kind,
  };
}

/* -------------------------- v2 reclaim (C2 recovery) -------------------------- */

export interface ReclaimableV2 {
  /** the drop id (32-byte link public key, hex) — pass to reclaimV2 */
  linkHex: string;
  usd: string;
  /** unix seconds the reclaim window opened (already past for a reclaimable drop) */
  expiry: number;
  /** A pool: take it back with `reclaimV2({ group: true })`, which calls reclaim_pool. */
  group?: boolean;
  /** How many shares the pool held, and how many were taken before it closed. */
  slots?: number;
  taken?: number;
}

/* ------------------------------- reading a pool ------------------------------- */

/**
 * What a pool can still do. Decided in one place so the claim screen and the sender's screen can
 * never disagree about the same record.
 *
 * `closed` is its own state and must be rendered as its own state. `reclaim_pool` sets
 * remaining = 0 AND claimed = slots together, so a pool the sender took the leftover back from reads
 * with every slot marked claimed - printing "6 of 6 taken" over a take-back would be the ledger's
 * words for a story that never happened. What a closed pool licenses saying is only this: nothing
 * more can be claimed and nothing more can be taken back.
 */
export type PoolStatus =
  /** shares left, deadline not passed */
  | "open"
  /** every share taken, deadline not passed */
  | "full"
  /** deadline passed with money still on the link - the sender can take it back */
  | "expired"
  /** deadline passed and the link holds nothing */
  | "closed";

export interface PoolState {
  linkHex: string;
  status: PoolStatus;
  /** what ONE claimant takes, exactly, as the contract stores it */
  perShare: string;
  /** what the link still holds, dust included */
  remaining: string;
  slots: number;
  /**
   * Shares taken, read straight off `claimed`. Never derived from a total minus `remaining`: the
   * deployed Pool struct carries no pot amount, and every remaining-derived formula reports a
   * take-back as a full payout. Meaningless when `status` is "closed" - branch on status first.
   */
  taken: number;
  sharesLeft: number;
  /** unix seconds the link closes */
  expiry: number;
  sender: string;
  /** the escrow that holds it (a link minted before an upgrade lives in a superseded one) */
  contract: string;
}

/** The four states, from the record alone. Pure, so the self-test can hold it to the contract. */
export function poolStatusOf(
  p: { remaining: bigint; slots: number; claimed: number; expiry: number },
  nowSec: number,
): PoolStatus {
  const past = nowSec >= p.expiry;
  const empty = p.remaining <= 0n;
  if (past) return empty ? "closed" : "expired";
  return p.claimed >= p.slots || empty ? "full" : "open";
}

/**
 * Read a pool from whichever escrow holds it. `null` when every escrow answered and none does;
 * a throw when one could not be asked, because "this link is empty" must never be a guess.
 */
export async function loadPool(
  linkHex: string,
  opts?: { net?: NetworkConfig; sourceAccount?: string },
): Promise<PoolState | null> {
  if (!isLinkHex(linkHex)) return null;
  const net = opts?.net ?? defaultNet();
  const server = new rpc.Server(net.rpcUrl);
  const nowSec = Math.floor(Date.now() / 1000);
  let unread = false;
  for (const contract of dropContracts(net)) {
    try {
      const p = await readView<PoolRecord>(server, contract, "get_pool", linkHex, net, opts?.sourceAccount);
      if (p == null) continue;
      const remaining = BigInt(p.remaining ?? 0n);
      const slots = Number(p.slots ?? 0);
      const claimed = Number(p.claimed ?? 0);
      const expiry = Number(p.expiry ?? 0);
      return {
        linkHex,
        status: poolStatusOf({ remaining, slots, claimed, expiry }, nowSec),
        perShare: stroopsToUsdc(BigInt(p.amount_per ?? 0n)),
        remaining: stroopsToUsdc(remaining),
        slots,
        taken: claimed,
        sharesLeft: Math.max(0, slots - claimed),
        expiry,
        sender: String(p.sender ?? ""),
        contract,
      };
    } catch {
      unread = true;
    }
  }
  if (unread) throw new Error("couldn't read the escrow");
  return null;
}

/* ------------------- what a device that already asked may honestly say -------------------- */

/**
 * The decision the claim screen renders on mount when this device holds a latch. Pure: it takes what
 * was actually looked up and returns what may be said, so "you already took your share, it's in your
 * account on this phone" can only be printed when somebody went and looked.
 *
 * `payoutUsd` is null for "we could not tell" (a 429, venue wifi, an account Horizon hasn't caught up
 * with). That is not zero, and it is not a reason to state where the money is.
 *
 * A "resume" that turns out to be unnecessary is cheap and safe - somebody who already swept their
 * share to their main account reads as empty here - because the resume presents the SAME payout and
 * the escrow answers "this address already has one", which is the truth and costs no second reserve.
 */
export type ResumeDecision =
  /** no latch: an ordinary first claim, say nothing */
  | { say: "nothing" }
  /** we looked, and the money is in the account this device already holds */
  | { say: "taken"; usd: string }
  /** we looked, the account is empty, and the link can still pay: one resume, same payout */
  | { say: "resume" }
  /** we looked, the account is empty, and the link cannot pay any more */
  | { say: "missed" }
  /** we could not look. Offer the claim, promise nothing */
  | { say: "unsure" };

export function resumeDecision(input: {
  latch: ClaimLatch | null;
  /** the latched payout's USDC balance, or null when we could not read it */
  payoutUsd: string | null;
  /** whether the link can still pay, or null when we could not read it */
  claimable: boolean | null;
}): ResumeDecision {
  if (!input.latch) return { say: "nothing" };
  if (input.payoutUsd === null) return { say: "unsure" };
  if (usdcStroops(input.payoutUsd) > 0n) return { say: "taken", usd: input.payoutUsd };
  if (input.claimable === null) return { say: "unsure" };
  return input.claimable ? { say: "resume" } : { say: "missed" };
}

/**
 * Resolve this device's latch against the ledger: what is in the payout account, and whether the
 * link can still pay. Reads only - nothing is created and no sponsor request is made.
 */
export async function readClaimProgress(
  linkHex: string,
  opts?: { net?: NetworkConfig; group?: boolean },
): Promise<{ decision: ResumeDecision; latch: ClaimLatch | null }> {
  const latch = readClaimLatch(linkHex);
  if (!latch) return { decision: { say: "nothing" }, latch: null };
  const net = opts?.net ?? defaultNet();
  const payoutUsd = await loadPayoutUsd(latch.payout, net);
  /* Only asked when the account came back empty - if the money is there, nothing about the link can
     change what this device may say, and the extra simulation would just slow the screen down. */
  let claimable: boolean | null = null;
  if (payoutUsd !== null && usdcStroops(payoutUsd) === 0n) {
    try {
      const server = new rpc.Server(net.rpcUrl);
      const probe = await readClaimState(server, linkHex, opts?.group ?? (latch.link === "group"), net);
      claimable = probe.state === "claimable";
    } catch {
      claimable = null;
    }
  }
  const decision = resumeDecision({ latch, payoutUsd, claimable });
  if (decision.say === "taken" && latch.state !== "taken") {
    writeClaimLatch(linkHex, { ...latch, state: "taken" });
  }
  return { decision, latch };
}

/**
 * The USDC this link's network says an account holds, or null when we could not tell.
 *
 * lib/horizon.ts reads the network this DEVICE is switched to, which is the practice one for a
 * first-time claimant holding a real-money link - so this reads the link's own network instead. A
 * 404 is "could not tell", not zero: an account Horizon has not caught up with is not an empty one.
 */
async function loadPayoutUsd(address: string, net: NetworkConfig): Promise<string | null> {
  try {
    const acc = await new Horizon.Server(net.horizonUrl).loadAccount(address);
    // Pinned by issuer, the same way lib/horizon.ts pins it: a look-alike token is not this money.
    const lines = acc.balances.filter((b) => "asset_code" in b && b.asset_code === "USDC") as {
      balance: string;
      asset_issuer?: string;
    }[];
    return lines.find((b) => b.asset_issuer === USDC_ISSUER[net.id])?.balance ?? "0";
  } catch {
    return null;
  }
}

/** Read a drop's on-chain state from ONE contract via its get_drop view (read-only simulation). */
async function readDropFrom(
  server: rpc.Server,
  sourceAccount: string,
  linkHex: string,
  contract: string,
  net: NetworkConfig,
): Promise<{ amount: bigint; expiry: number; claimed: boolean } | null> {
  const d = await readView<{ amount?: bigint; expiry?: bigint | number; claimed?: boolean }>(
    server,
    contract,
    "get_drop",
    linkHex,
    net,
    sourceAccount,
  );
  if (!d) return null; // None ⇒ this contract doesn't hold the drop (or it's already gone)
  return { amount: BigInt(d.amount ?? 0n), expiry: Number(d.expiry ?? 0), claimed: !!d.claimed };
}

/**
 * Read a drop from whichever escrow holds it (current first, then superseded ones).
 *
 * `null` means every escrow answered and none holds it. An escrow we could not ask THROWS, because
 * the caller above turns "no drop" into "this payment is settled" - and an unreachable RPC reported
 * as a settlement is a sender being told their money arrived when nobody has touched it.
 */
async function readDrop(
  server: rpc.Server,
  sourceAccount: string,
  linkHex: string,
  net: NetworkConfig,
): Promise<({ amount: bigint; expiry: number; claimed: boolean } & { contract: string }) | null> {
  let unread = false;
  for (const contract of dropContracts(net)) {
    try {
      const d = await readDropFrom(server, sourceAccount, linkHex, contract, net);
      if (d) return { ...d, contract };
    } catch {
      unread = true; // unreachable contract => try the next one
    }
  }
  if (unread) throw new Error("couldn't read the escrow");
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
  /**
   * `group: true` asks get_pool instead of get_drop. Without it an unconfirmed pool reads as
   * "nothing moved", and the retry that follows mints a SECOND pot under a fresh link key with the
   * whole amount escrowed twice - the worst money bug this path has.
   */
  opts?: { group?: boolean },
): Promise<boolean | "unknown"> {
  const net = defaultNet();
  const server = new rpc.Server(net.rpcUrl);
  try {
    return (
      (await readView(
        server,
        net.contract,
        opts?.group ? "get_pool" : "get_drop",
        linkHex,
        net,
        sourceAccount,
      )) != null
    );
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
  /**
   * `group: true` reads the pool. A pool has no get_drop record at all, so without this every group
   * link a sender ever made reads "settled" the instant it is created - money still on the link,
   * reported as received.
   */
  opts?: { group?: boolean },
): Promise<"pending" | "settled" | "unknown"> {
  try {
    const net = defaultNet();
    if (opts?.group) {
      const pool = await loadPool(linkHex, { net, sourceAccount });
      if (!pool) return "settled";
      // Still the sender's business while shares are open OR while there is a leftover to take back.
      return pool.status === "open" || pool.status === "expired" ? "pending" : "settled";
    }
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
  let records: Record<string, { balanceId?: string; slots?: number }>;
  try {
    records = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as typeof records;
  } catch {
    return [];
  }
  /* `slots` on the local record is what says a link is a POOL. It is a display hint that decides
     which view is asked - the escrow still has the final word on what is there - and without it a
     pool is probed with get_drop, finds nothing, and never appears as money to take back. */
  const links = new Map<string, number | undefined>();
  for (const r of Object.values(records)) {
    const b = r.balanceId;
    if (typeof b === "string" && /^[0-9a-f]{64}$/i.test(b) && !links.has(b)) {
      links.set(b, typeof r.slots === "number" ? r.slots : undefined);
    }
  }
  if (links.size === 0) return [];
  const server = new rpc.Server(net.rpcUrl);
  const nowSec = Math.floor(Date.now() / 1000);
  // Parallel per-drop reads (bounded by the local send count) so the bell poll stays light.
  const results = await Promise.all(
    Array.from(links, async ([linkHex, slots]): Promise<ReclaimableV2 | null> => {
      try {
        if (slots !== undefined && slots >= MIN_POOL_SLOTS) {
          const pool = await loadPool(linkHex, { net, sourceAccount: sender });
          // "expired" is precisely the reclaimable state: past the deadline with money still on it.
          if (pool && pool.status === "expired") {
            return {
              linkHex,
              usd: pool.remaining,
              expiry: pool.expiry,
              group: true,
              slots: pool.slots,
              taken: pool.taken,
            };
          }
          return null;
        }
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
  /**
   * true for a group drop (reclaim_pool), false for a one-to-one drop (reclaim). OMIT IT and the
   * escrow is asked: a pool and a drop live in separate storage maps, so this is answerable, and
   * every caller that had no way to know (the bell, the agent tool) would otherwise send a pool's
   * take-back to `reclaim`, which reverts with nothing moved and no way for the screen to explain it.
   */
  group?: boolean;
}): Promise<{ hash: string }> {
  const net = defaultNet();
  const server = new rpc.Server(net.rpcUrl);
  const sender = opts.signer.publicKey();
  /* A wrong answer here cannot move money the wrong way - the contract simply refuses a `reclaim`
     on a link it holds no Drop for - so an escrow we could not read falls back to the one-to-one
     path this function has always taken. */
  let group = opts.group;
  if (group === undefined) {
    group = await loadPool(opts.linkHex, { net, sourceAccount: sender })
      .then((p) => p !== null)
      .catch(() => false);
  }
  const method = group ? "reclaim_pool" : "reclaim";
  // Your own money can be sitting in a superseded escrow — reclaim from wherever it is.
  const contract = await resolveDropContract(server, sender, opts.linkHex, group);
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
