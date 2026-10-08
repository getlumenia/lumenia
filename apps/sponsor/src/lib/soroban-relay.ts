/**
 * /v2-claim — the v2 (Soroban) claim relayer. The recipient's link key signs a payout off-chain;
 * this endpoint SUBMITS the LumenDrop `claim` / `claim_share` and pays the Soroban fee, so the
 * recipient is walletless + gasless. Mirrors the fee-bump relayer, but for a Soroban invoke.
 *
 * Safety is enforced BY THE CONTRACT (auditable bytecode): the escrow only releases the deposited
 * USDC to the address the link key signed — the relayer can NEVER redirect a stroop (proven on-chain,
 * 7/7). So the sponsor's guard here is minimal + tight: only the KNOWN LumenDrop contract, only the
 * two claim methods, valid 32-byte link + 64-byte sig. The sponsor sources the tx (pays fees) and
 * can never lose value — it holds no USDC in this path.
 */
import { rpc, Address, Contract, TransactionBuilder, scValToNative, xdr, type Account, type Transaction, type FeeBumpTransaction } from "@stellar/stellar-sdk";
import { capsFromEnv, chargeSponsorFee, checkCaps, PublicRefusal, signCharged, stroopsToUsdc } from "./caps.js";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { feeChargedOf, isSubmitUnconfirmed, SubmitUnconfirmedError } from "./stellar.js";
import { CHANNEL_LEASE_TTL_SECONDS, type ChannelManager } from "./channels.js";

const ALLOWED_METHODS = new Set<string>(["claim", "claim_share"]);
/**
 * The two escrow-CREATING methods a sender may relay. `deposit` mints a one-to-one drop,
 * `create_drop` a group pool of equal shares — the same money movement (the sender's own USDC
 * into the escrow, authorized by the sender), differing only in how the contract will later let
 * it out. Both go through the identical guard below and the identical canary cap.
 *
 * `create_drop` was missing for a while, and the gap was invisible from the contract's side: the
 * claim relay already accepted `claim_share` and the reclaim relay `reclaim_pool`, so a group
 * pool could be claimed and reclaimed gaslessly but never CREATED gaslessly. Since every Lumenia
 * account holds 0 XLM by design, that meant no user could make one at all.
 */
export const ALLOWED_DEPOSIT_METHODS = new Set<string>(["deposit", "create_drop"]);
/** Argument count per method: deposit(from,link,amount,expiry) / create_drop(+slots). */
const DEPOSIT_ARITY: Record<string, number> = { deposit: 4, create_drop: 5 };

/**
 * How many shares one group link may hold. Nothing else bounds this: the contract asks only that
 * `amount >= slots`, and the canary caps bind the POT, not the number of ways it is cut. Slots is
 * the multiplier on sponsored onboarding (every share claimed opens a fresh account at ~1.5 XLM of
 * sponsor reserve that nobody ever gives back), so it is the sponsor's own spend and the sponsor is
 * the one who has to bound it. Two is the smallest thing that is a group at all.
 *
 * MAINNET (owner decision, 2026-09-20): group links are open there, and the bound is what makes
 * that safe rather than a blanket refusal. Three things hold it: the $5 per-transfer cap binds the
 * whole POT, the per-share floor keeps a cent from buying thirty accounts, and this ceiling bounds
 * the reserve a single link can mortgage. At six seats a mainnet pool costs about 9 XLM of
 * sponsored reserve against a float that onboards roughly 88 people, so one pool is a tenth of the
 * day rather than half of it.
 *
 * The mainnet numbers do NOT come from configuration alone. `[env.mainnet.vars]` redeclares the
 * variable block rather than inheriting it, so a variable left out there is simply undefined, and
 * the old code read that as "use the testnet default", which is the opposite of safe. So on mainnet
 * an absent variable gives the tight default and no variable can raise the ceiling: configuration
 * may only ever make it smaller.
 */
const MIN_POOL_SLOTS = 2;
const DEFAULT_MAX_POOL_SLOTS = 30;
const MAINNET_DEFAULT_POOL_SLOTS = 6;
const MAINNET_POOL_SLOTS_CEILING = 8;

/** Read at call time, not at module load: the Worker hydrates process.env per request. */
function maxPoolSlots(network: SponsorConfig["network"]): number {
  const raw = process.env.MAX_POOL_SLOTS;
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  const configured = Number.isInteger(n) && n >= MIN_POOL_SLOTS ? n : null;
  if (network === "mainnet") {
    return Math.min(configured ?? MAINNET_DEFAULT_POOL_SLOTS, MAINNET_POOL_SLOTS_CEILING);
  }
  return configured ?? DEFAULT_MAX_POOL_SLOTS;
}

/**
 * The LumenDrop error discriminants a GROUP claim can revert with, as stable tokens the claim
 * screen can classify (contracts/lumen-drop/src/lib.rs: DropEmpty 7, AlreadyClaimedThis 8,
 * Expired 9). Every one of them is terminal: the same link and the same payout address will get
 * the same answer for ever, and each retry the browser offers opens ANOTHER sponsored account.
 */
const GROUP_CLAIM_ERROR_TOKENS: Record<number, string> = {
  7: "drop-empty",
  8: "already-claimed-this",
  9: "expired",
};

/** The two reclaim methods a sender may relay to recover their OWN unclaimed drop after expiry. */
const ALLOWED_RECLAIM_METHODS = new Set<string>(["reclaim", "reclaim_pool"]);
/** Max fee (stroops) the sponsor will fee-bump a v2 deposit to (~2 XLM; a deposit costs ~0.2). */
const V2_DEPOSIT_FEE_CAP = 20_000_000;
/**
 * How far above the simulated resource fee a relayed reclaim's inner fee may sit (stroops). The
 * web client assembles its reclaim with a 0.2 XLM inclusion fee on top of the resource fee, so
 * that is the honest figure plus slack; anything higher is somebody spending the sponsor's XLM.
 */
const V2_RECLAIM_INCLUSION_HEADROOM = 2_500_000;
/**
 * The same bound for a relayed DEPOSIT (SOW 2, D3 item a). Until this existed the deposit relay
 * trusted whatever fee the client had written, up to the 2 XLM cap, and fee-bumped it unread: on an
 * open mainnet that is a 2 XLM-per-request bill against the sponsor's float, bounded only by the
 * rate limit. The web builds a deposit with a 2,000,000-stroop inclusion fee on top of the
 * simulated resource fee (apps/web/lib/lumendrop.ts, createV2Link / createV2GroupLink), so 0.25 XLM
 * is that figure plus slack for a resource fee that moved between the client's simulation and ours.
 * The absolute V2_DEPOSIT_FEE_CAP stays as the outer bound.
 */
const DEPOSIT_INCLUSION_HEADROOM = 2_500_000;

/**
 * The slice of the Soroban RPC the relays use, so a test can stand in a fake for all of it
 * (simulate / send / poll) and the single-shot cap accounting can be proven per branch without a
 * network. `rpc.Server` satisfies it as is.
 */
export interface RelayRpc {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction | FeeBumpTransaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface RelayDeps {
  /** Builds the RPC client for a url. Defaults to `new rpc.Server(url)`. */
  rpc?: (url: string) => RelayRpc;
  /** Confirm-wait tuning for tests only; production keeps the values below. */
  pollMs?: number;
  maxPolls?: number;
}

const defaultRpc = (url: string): RelayRpc => new rpc.Server(url);

/**
 * The RPC declined to QUEUE a transaction (`sendTransaction` status TRY_AGAIN_LATER): the network
 * is busy and nothing was accepted, so nothing can land. The worker answers 503 with this sentence,
 * which the claim screen reads as a short wait worth a retry (apps/web/lib/claim-error.ts keys on
 * "shortly"). It is a public sentence on purpose: it names no policy and no internals.
 */
export class RelayBusyError extends Error {
  readonly relayBusy = true;
  constructor() {
    super("the network is busy; try again shortly");
    this.name = "RelayBusyError";
  }
}

/** True for a submission the RPC refused to queue because it was busy. Reads the brand. */
export function isRelayBusy(e: unknown): boolean {
  return e instanceof RelayBusyError || (e as { relayBusy?: boolean } | null | undefined)?.relayBusy === true;
}

/** The deposit/reclaim confirm wait: 40 polls of 1.5 s, the same 60 s as the claim's timebound. */
const V2_SUBMIT_POLL_MS = 1500;
const V2_SUBMIT_MAX_POLLS = 40;

/**
 * The fee-bump base for a Soroban inner transaction: its own inclusion fee per operation (the fee
 * minus the declared resource fee), never below the 100-stroop network minimum. That is the SDK's
 * own minimum (TransactionBuilder.buildFeeBumpTransaction refuses anything lower), and the bid it
 * builds from it is base x (ops + 1) + resourceFee.
 *
 * Every relay used to pass the inner's TOTAL fee as the base, which bid the resource fee three
 * times, 2 x (I + R) + R instead of 2 x I + R: 4,672,960 stroops instead of 4,224,320 for an honest
 * testnet deposit, and about 40% more where the resource fee is large. The bid is what the day's fee
 * budget holds while a transaction is in flight, so the overstatement refused traffic for nothing.
 */
export function feeBumpBase(inner: Transaction): string {
  const ops = BigInt(Math.max(1, inner.operations.length));
  const resource = declaredResourceFee(inner);
  const perOp = (BigInt(inner.fee) + ops - 1n) / ops - resource; // the SDK's fee / ops, rounded up, less R
  /* A Soroban inner whose declared resource fee leaves less than the 100-stroop minimum for
     inclusion is malformed, and core refuses it. Flooring the base at 100 here would still have the
     sponsor BID 200 + R for it, with R whatever the client wrote; refused instead, never floored. */
  if (resource < 0n) throw new Error(`the inner declares a negative resource fee (${resource})`);
  if (resource > 0n && perOp < 100n) {
    throw new Error(`the inner declares a resource fee (${resource}) that its fee (${inner.fee}) cannot cover`);
  }
  return (perOp > 100n ? perOp : 100n).toString();
}

/** The Soroban resource fee an inner transaction DECLARES (its sorobanData), 0 for a classic one. */
export function declaredResourceFee(inner: Transaction): bigint {
  const env = inner.toEnvelope();
  if (env.switch().name !== "envelopeTypeTx") return 0n;
  const data = env.v1().tx().ext().value() as xdr.SorobanTransactionData | undefined;
  return data ? BigInt(data.resourceFee().toString()) : 0n;
}

/**
 * The declared resource fee must fit inside the inner's own fee with room for the minimum inclusion
 * fee. The fee bounds above cap the TOTAL, but a sender-signed inner may declare a resource fee
 * larger than that total: core refuses such an inner, yet the fee-bump around it bids 200 + R before
 * core says so, and R was the client's to choose. A review declared 14 XLM and the sponsor signed a
 * 14 XLM bid, which held most of mainnet's day while it was in flight (all of it until UTC midnight
 * had the send gone unanswered). Checked before any reservation, so a refusal costs nothing.
 */
function refuseOversizedResourceFee(inner: Transaction, route: string): void {
  const declared = declaredResourceFee(inner);
  // The field is a signed int64: a NEGATIVE declared fee raised the base above the inner's own fee
  // and the bid with it (a review had a 0.2 XLM inner with R = -14 XLM bid 14.4 XLM).
  if (declared < 0n) throw new Error(`${route}: the inner declares a negative resource fee`);
  if (declared > BigInt(inner.fee) - 100n) {
    throw new Error(`${route}: the inner declares a resource fee its own fee cannot cover`);
  }
}

/**
 * The bid a relay may sign for a one-operation inner: with 0 <= R <= fee - 100 the fee-bump bids
 * `2 x (fee - R) + R`, at most twice the inner's own fee. Checked on the BUILT fee-bump, so a bid
 * the guards above did not foresee is refused before the charge and the signature.
 */
function refuseInflatedBid(feeBump: { fee: string }, inner: Transaction, route: string): void {
  if (BigInt(feeBump.fee) > 2n * BigInt(inner.fee)) {
    throw new Error(`${route}: fee-bump bid ${feeBump.fee} exceeds twice the inner fee ${inner.fee}`);
  }
}

/**
 * Is a throw from `sendTransaction` a refusal that reached nothing, or an answer that never came?
 * The SDK (16.x, lib/rpc/jsonrpc.js) throws the JSON-RPC `error` object itself when the server
 * answered with one, and its HTTP client throws an Error carrying `response.status` for an HTTP
 * failure and none for a transport failure.
 *
 * Refused outright: the request-shape JSON-RPC codes (-32700 parse error, -32600 invalid request,
 * -32601 method not found, -32602 invalid params; the RPC refused before submitting anything) and
 * an HTTP 4xx other than 408 (a gateway or the RPC refused the request itself). Everything else may
 * have queued the transaction and is UNDECIDED: a -32603 internal error (also what the RPC answers
 * when its own call to core failed), a 5xx, a 408, a reset, a timeout.
 */
function sendRefusedOutright(e: unknown): boolean {
  if (e && typeof e === "object" && !(e instanceof Error) && "code" in e) {
    const code = (e as { code?: unknown }).code;
    return code === -32700 || code === -32600 || code === -32601 || code === -32602;
  }
  const status = (e as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}

/** A thrown value as one log line, whether the SDK threw an Error or a JSON-RPC error object. */
function describeThrow(e: unknown): string {
  if (e instanceof Error) return e.message;
  const rpcErr = e as { code?: unknown; message?: unknown } | null | undefined;
  if (rpcErr && typeof rpcErr === "object") return `${String(rpcErr.code ?? "")} ${String(rpcErr.message ?? "")}`.trim();
  return String(e);
}

/**
 * Charge, sign, send and watch ONE sponsor-paid Soroban transaction: the part every relay shares
 * (SOW 2, D3 items b, c and g), in one place so the relays cannot drift apart.
 *
 *   - the day's fee budget takes the bid before the signature, and the network's answer settles it
 *     (lib/caps.ts): the signer throwing, ERROR, TRY_AGAIN_LATER and a send refused outright give it
 *     back; an included transaction (SUCCESS or FAILED) counts what its result says it was charged;
 *     anything undecided keeps the whole bid;
 *   - a send that THROWS without a definitive refusal is undecided, not failed: the RPC may have
 *     queued the transaction before its answer was lost. It is raised as SubmitUnconfirmedError
 *     with the hash, so the caller keeps its cap reservation, the worker keeps the pilot slot and
 *     answers 202, and the client settles it against the ledger. Until 2026-10-08 this branch was a
 *     plain 400 that released both and told the sender "your money hasn't moved" for a deposit
 *     that could still land;
 *   - TRY_AGAIN_LATER raises RelayBusyError: 503, nothing queued.
 *
 * Returns the hash and the last poll answer: SUCCESS, FAILED, or NOT_FOUND after the window.
 * Throws a plain Error (or RelayBusyError) only when nothing reached the network, and
 * SubmitUnconfirmedError for everything undecided; `isSubmitUnconfirmed` tells the two apart.
 */
export async function payAndSubmit(
  server: RelayRpc,
  signer: SponsorSigner,
  tx: Transaction | FeeBumpTransaction,
  label: string,
  deps: RelayDeps,
  window: { pollMs: number; maxPolls: number },
): Promise<{ hash: string; got: rpc.Api.GetTransactionResponse }> {
  const charge = await chargeSponsorFee(tx.fee);
  await signCharged(charge, () => signer.sign(tx));
  const hash = tx.hash().toString("hex");

  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await server.sendTransaction(tx);
  } catch (e) {
    if (sendRefusedOutright(e)) {
      await charge.notIncluded();
      throw new Error(`${label} send refused: ${describeThrow(e)}`);
    }
    throw new SubmitUnconfirmedError(`${label}: the RPC did not answer the send (${describeThrow(e)})`, hash);
  }
  // A send ERROR is stellar-core refusing the transaction outright: it "will not be included in the
  // ledger" (developers.stellar.org/docs/data/apis/rpc/api-reference/methods/sendTransaction).
  if (sent.status === "ERROR") {
    await charge.notIncluded();
    throw new Error(`${label} send failed: ${JSON.stringify(sent.errorResult)}`);
  }
  // The RPC declined to queue it at all: nothing is on the network.
  if (sent.status === "TRY_AGAIN_LATER") {
    await charge.notIncluded();
    throw new RelayBusyError();
  }
  // PENDING, or DUPLICATE: a transaction the RPC already holds is on the network just the same.
  const got = await pollUntilDecided(server, sent.hash, deps, window);
  if (got.status === rpc.Api.GetTransactionStatus.SUCCESS || got.status === rpc.Api.GetTransactionStatus.FAILED) {
    // Included, so it paid: the count drops from the bid to the fee its result names.
    await charge.settled(feeChargedOf((got as { resultXdr?: xdr.TransactionResult }).resultXdr));
  }
  return { hash: sent.hash, got };
}

/**
 * Watch a transaction the RPC has accepted until the ledger decides it, or the window closes.
 *
 * Everything after `sendTransaction` accepted is us OBSERVING a transaction that is on the
 * network. An RPC that stops answering mid-poll therefore cannot be reported as "it failed": the
 * transaction may land a second later. It is raised as `SubmitUnconfirmedError` with the hash, the
 * same brand `lib/stellar.ts` uses for a Horizon answer that never came, and the worker turns that
 * into a 202 on every network (the mainnet redaction never touches it).
 */
async function pollUntilDecided(
  server: RelayRpc,
  hash: string,
  deps: RelayDeps,
  defaults: { pollMs: number; maxPolls: number },
): Promise<rpc.Api.GetTransactionResponse> {
  const pollMs = deps.pollMs ?? defaults.pollMs;
  const maxPolls = deps.maxPolls ?? defaults.maxPolls;
  try {
    let got = await server.getTransaction(hash);
    for (let i = 0; i < maxPolls && got.status === rpc.Api.GetTransactionStatus.NOT_FOUND; i++) {
      await sleep(pollMs);
      got = await server.getTransaction(hash);
    }
    return got;
  } catch (e) {
    throw new SubmitUnconfirmedError(`the RPC stopped answering while the transaction was being watched: ${(e as Error).message}`, hash);
  }
}

/**
 * Timebound (s) for a v2-claim tx AND the confirm-wait budget — kept EQUAL on purpose:
 * a tx still unconfirmed when the channel lease is released is already past its maxTime
 * (tx_too_late → it can never land after the channel is reused, so no cross-lease
 * collision). MUST be < the channel lease TTL (the lease is the outer safety net). The
 * fenced release (see channels.ts) is the belt to this suspenders.
 */
const V2_CLAIM_TIMEOUT_SECONDS = 60;
const V2_CLAIM_POLL_MS = 1500;
if (V2_CLAIM_TIMEOUT_SECONDS >= CHANNEL_LEASE_TTL_SECONDS) {
  throw new Error("v2-claim timeout must be < channel lease TTL");
}

export interface RelayClaimInput {
  /** LumenDrop method: "claim" (one-to-one) or "claim_share" (group). */
  method: string;
  /** The link's Ed25519 public key as 32-byte hex (the drop id). */
  linkHex: string;
  /** The payout account (G… or C…) the link key signed for. */
  payout: string;
  /** The 64-byte Ed25519 signature as hex. */
  sigHex: string;
  /**
   * Which LumenDrop holds this drop. Defaults to the CURRENT contract; a superseded id from
   * `lumendropLegacyContracts` is accepted so links minted before an upgrade still claim.
   * Any other value is rejected.
   */
  contract?: string;
}

/**
 * Resolve + authorize the escrow contract for an EXIT (claim / reclaim). New escrow always goes
 * to the current contract; exits may also target a superseded one, because a drop can only ever
 * be released by the contract that holds it. Every id here is one we deployed, and each enforces
 * its own in-contract signature (claim) or sender auth (reclaim) — so the relayer gains nothing.
 */
function exitContract(config: SponsorConfig, requested?: string): string {
  const current = config.lumendropContract!;
  if (!requested || requested === current) return current;
  if (config.lumendropLegacyContracts.includes(requested)) return requested;
  throw new Error(`contract not allowed: ${requested}`);
}

export interface RelayClaimResult {
  hash: string;
  /**
   * Did we OBSERVE this transaction land? Present on every relay since SOW 2 D3 (item g); it was
   * /v2-deposit only before.
   *
   * `false` means the ledger accepted it for inclusion but the RPC had not shown us the result
   * before our poll window closed: an ordinary outcome under congestion, and NOT a failure. The
   * distinction has to survive all the way to the caller, because "the deposit did not happen" is
   * the one claim that must never be guessed: acting on it means depositing again, and on a claim
   * it means minting another sponsored payout account (another onboarding slot and 1.5 XLM) to ask
   * a question whose answer is already on the ledger. The worker answers 202 for `false`.
   */
  confirmed: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* A refusal's message reaches the error log on both networks (worker.ts logs it before the mainnet
   response is redacted), and a log is no place for somebody's full account address. Four characters
   are enough to tell two refusals apart; the whole address is never needed to read a log (SOW 2, D2). */
const shortKey = (k: string): string => `${k.slice(0, 4)}...`;

/** First ScError anywhere in an ScVal (a host error event nests its own inside a vec). */
function findScError(v: xdr.ScVal): xdr.ScError | null {
  if (v.switch().name === "scvError") return v.error();
  if (v.switch().name === "scvVec") {
    for (const item of v.vec() ?? []) {
      const found = findScError(item);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Name WHY a relayed group claim reverted, from the diagnostic events the RPC returns with a
 * FAILED transaction.
 *
 * Until now every revert reached the browser as the literal string "v2-claim tx FAILED", which the
 * claim screen could only file under "unknown" and therefore offered a RETRY button for. On stage
 * that is a loop: the retry mints a fresh payout address, opens another sponsored account against
 * it, and asks the contract a question whose answer cannot change. So the reason has to survive the
 * trip as something the client can key on.
 *
 * The contract code is not in the transaction result (a reverting invoke records only
 * INVOKE_HOST_FUNCTION_TRAPPED there), it is in the diagnostic events, where the host writes the
 * failing ScVal into the event's topics and data. A bad link signature is the one case with no
 * contract code at all: `ed25519_verify` traps in the host, so it surfaces as a CRYPTO ScError.
 * Anything we cannot name returns "unknown", which the claim screen treats as terminal too.
 */
export function groupClaimFailureToken(events: readonly xdr.DiagnosticEvent[] | undefined): string {
  for (const ev of events ?? []) {
    const body = ev.event().body();
    if (body.switch() !== 0) continue; // only the v0 arm carries topics + data
    const v0 = body.v0();
    for (const sc of [...v0.topics(), v0.data()]) {
      const err = findScError(sc);
      if (!err) continue;
      if (err.switch().name === "sceCrypto") return "bad-link-key";
      if (err.switch().name !== "sceContract") continue;
      const token = GROUP_CLAIM_ERROR_TOKENS[err.contractCode()];
      if (token) return token;
    }
  }
  return "unknown";
}

export async function relayClaimHandler(
  config: SponsorConfig,
  signer: SponsorSigner,
  input: RelayClaimInput,
  channels?: ChannelManager,
  deps: RelayDeps = {},
): Promise<RelayClaimResult> {
  if (!config.lumendropContract) throw new Error("v2 relayer not configured (LUMENDROP_CONTRACT unset)");
  if (!ALLOWED_METHODS.has(input.method)) throw new Error(`method not allowed: ${input.method}`);
  const contract = exitContract(config, input.contract);

  const link = Buffer.from(input.linkHex, "hex");
  const sig = Buffer.from(input.sigHex, "hex");
  if (link.length !== 32) throw new Error("link must be 32 bytes (hex)");
  if (sig.length !== 64) throw new Error("sig must be 64 bytes (hex)");
  // Address.fromString throws on a malformed payout — reject before spending a simulation.
  const payoutScVal = Address.fromString(input.payout).toScVal();

  const server = (deps.rpc ?? defaultRpc)(config.sorobanRpcUrl);

  // C1: like /create-account, the sponsor-sourced submit serializes concurrent v2 claims
  // on the sponsor's ONE sequence. Lease a CHANNEL to source the tx (its own sequence)
  // and FEE-BUMP with the sponsor — the sponsor stays the fee source, the channel only
  // lends its sequence. This path SERVER-submits, so the lease is released as soon as the
  // tx confirms (high reuse). No channel/lease ⇒ the sponsor-sourced fallback.
  const lease = channels?.enabled ? await channels.lease() : null;
  /* A claim whose outcome is UNDECIDED (the send went unanswered, or the RPC died mid-poll) may
   * still land inside its 60 s timebound on this channel's sequence. Its lease is kept and left to
   * lapse (150 s TTL) instead of being freed at once: the next claim would otherwise build on the
   * same sequence and collide with it (TRY_AGAIN_LATER or tx_bad_seq, and another fee bid). */
  let keepLease = false;
  try {
    const sourcePub = lease ? lease.publicKey : config.sponsorAccountId;
    const source = await server.getAccount(sourcePub);
    const tx = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: config.networkPassphrase })
      .addOperation(
        new Contract(contract).call(
          input.method,
          xdr.ScVal.scvBytes(link),
          payoutScVal,
          xdr.ScVal.scvBytes(sig),
        ),
      )
      .setTimeout(V2_CLAIM_TIMEOUT_SECONDS)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`v2-claim simulation failed: ${sim.error}`);
    const prepared = rpc.assembleTransaction(tx, sim).build();

    // The sponsor pays this fee, and until now nothing bounded it: the amount came straight out of
    // simulation, so a claim crafted to be expensive to execute billed the sponsor whatever it
    // cost. /v2-deposit and /v2-reclaim already refuse an inner fee over this ceiling — the
    // relayed claim is the same spend and gets the same ceiling.
    if (Number.parseInt(prepared.fee, 10) > V2_DEPOSIT_FEE_CAP) {
      throw new Error(`v2-claim fee ${prepared.fee} exceeds cap ${V2_DEPOSIT_FEE_CAP}`);
    }

    let submitTx: Transaction | FeeBumpTransaction;
    if (lease) {
      // Channel = tx source (lends its sequence). Its signature on the inner is made before the
      // charge, because the fee-bump copies the inner envelope as it is when built; the inner never
      // leaves this process unless the sponsor's own signature below follows, so a refused charge
      // posts nothing.
      prepared.sign(lease.keypair);
      // Fee-bump so the SPONSOR pays the Soroban fee (mirrors /v2-deposit), at the smallest base
      // the SDK accepts (`feeBumpBase`).
      submitTx = TransactionBuilder.buildFeeBumpTransaction(
        config.sponsorAccountId,
        feeBumpBase(prepared),
        prepared,
        config.networkPassphrase,
      );
    } else {
      submitTx = prepared; // sponsor = tx source (fallback)
    }

    // Charge the bid, sign, send and watch (D3 items b, c, g). The confirm-wait is bounded to
    // V2_CLAIM_TIMEOUT_SECONDS (= the tx timebound), so a tx not yet in a ledger by then is already
    // tx_too_late; the lease is freed only after this, and only for a decided outcome.
    const { hash, got } = await payAndSubmit(server, signer, submitTx, "v2-claim", deps, {
      pollMs: V2_CLAIM_POLL_MS,
      maxPolls: Math.ceil((V2_CLAIM_TIMEOUT_SECONDS * 1000) / V2_CLAIM_POLL_MS),
    });
    /* A group claim the ledger definitively REFUSED comes back as a named reason, not as a status
     * string. NOT_FOUND is deliberately left alone below: that transaction may still land, and
     * calling it a failure is the one thing this relay must never guess. */
    if (got.status === rpc.Api.GetTransactionStatus.FAILED && input.method === "claim_share") {
      throw new PublicRefusal(`group-claim-failed: ${groupClaimFailureToken(got.diagnosticEventsXdr)}`);
    }
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`v2-claim tx ${got.status}`);
    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash, confirmed: true };
    /* Still NOT_FOUND after the window. This used to throw "v2-claim tx NOT_FOUND", which the
     * worker answered as a 400 and, on mainnet, redacted to "request failed": the one answer the
     * claim screen could only read as "failed, try again", and each retry minted a fresh payout
     * account. Say what is true instead: accepted, undecided, here is the hash. The web settles it
     * against the ledger (the transaction's own status, then the payout's balance) before it says
     * anything. */
    return { hash, confirmed: false };
  } catch (e) {
    if (isSubmitUnconfirmed(e)) keepLease = true;
    throw e;
  } finally {
    // Server-submit path: the channel is free the instant this claim is DECIDED (or never sent).
    if (lease && !keepLease) await lease.release();
  }
}

export interface RelayDepositInput {
  /** The sender-signed, fully-assembled inner deposit tx (base64 XDR). */
  xdr: string;
  /** The sender that must source the inner tx. */
  senderPublicKey: string;
}

/**
 * /v2-deposit — gasless v2 deposit relayer. A 0-XLM sender builds + signs a LumenDrop `deposit`
 * invoke (authorizing the USDC transfer into the escrow); the sponsor FEE-BUMPS it so the sender
 * pays no gas (proven: the gasless-deposit spike, 5/5). The sponsor can never lose value — the USDC
 * is the sender's own, and the fee-bump only pays the tx fee. Tight guard: the inner MUST be a
 * single `deposit` or `create_drop` invoke on the KNOWN LumenDrop contract, sourced by the sender,
 * under the fee cap, simulated here before anything is paid, and within the canary caps.
 */
export async function relayDepositHandler(
  config: SponsorConfig,
  signer: SponsorSigner,
  input: RelayDepositInput,
  deps: RelayDeps = {},
): Promise<RelayClaimResult> {
  if (!config.lumendropContract) throw new Error("v2 relayer not configured (LUMENDROP_CONTRACT unset)");
  const inner = TransactionBuilder.fromXDR(input.xdr, config.networkPassphrase) as Transaction;

  if (inner.source !== input.senderPublicKey) throw new Error(`unexpected inner source ${shortKey(inner.source)}`);
  if (inner.operations.length !== 1) throw new Error("deposit tx must have exactly 1 op");
  const op = inner.operations[0] as { type: string; func?: xdr.HostFunction };
  if (op.type !== "invokeHostFunction" || !op.func) throw new Error("not a contract invoke");
  if (op.func.switch().name !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  const ic = op.func.invokeContract();
  const calledContract = Address.fromScAddress(ic.contractAddress()).toString();
  const calledFn = ic.functionName().toString();
  // NEW escrow only ever goes into the CURRENT contract (the legacy one is read/exit-only).
  if (calledContract !== config.lumendropContract) throw new Error("wrong contract");
  if (!ALLOWED_DEPOSIT_METHODS.has(calledFn)) {
    throw new Error(`only deposit/create_drop is relayed here, got '${calledFn}'`);
  }
  if (Number.parseInt(inner.fee, 10) > V2_DEPOSIT_FEE_CAP) {
    throw new Error(`inner fee ${inner.fee} exceeds cap ${V2_DEPOSIT_FEE_CAP}`);
  }

  /* Canary caps. Both methods put the escrowed amount at arg 2 —
   *   deposit(from, link, amount, expiry)
   *   create_drop(from, link, amount, slots, expiry)
   * — and for a pool that amount is the WHOLE pool, which is the right thing to cap: it is the
   * total the sponsor is facilitating into escrow, however many ways the contract later splits
   * it. Read from the XDR rather than a client field, so the cap binds what the ledger will
   * actually execute. */
  const args = ic.args();
  const arity = DEPOSIT_ARITY[calledFn]!;
  if (args.length !== arity) throw new Error(`${calledFn} expects ${arity} args, got ${args.length}`);
  /* The USDC that moves is `from`'s (args[0]), and every per-sender bound below, the day cap's
   * sender share and the pilot slot, is keyed on `senderPublicKey`. They must be the same key: a
   * review showed deposit(from = W) sourced by another account S was accepted with the reservation
   * on S, so W could move the whole day across two such accounts past its own share, and on a
   * pilot Worker an approved S could relay an unapproved W's money. The web always builds
   * from = sender, so this refuses nothing honest. */
  let from: string;
  try {
    from = Address.fromScVal(args[0]!).toString();
  } catch {
    throw new Error(`${calledFn}: 'from' is not an address`);
  }
  if (from !== input.senderPublicKey) {
    throw new Error(`${calledFn} must move the sender's own USDC ('from' ${shortKey(from)} is not the sender)`);
  }
  const amountStroops = BigInt(scValToNative(args[2]!) as bigint | number | string);
  const caps = capsFromEnv();

  /* A POOL has a second number, and it is the one that spends the SPONSOR rather than the sender.
   * Both bounds below are read from the same XDR as the amount, for the same reason. */
  if (calledFn === "create_drop") {
    const slots = scValToNative(args[3]!) as unknown;
    /* Check the TYPE before comparing anything. `slots` arriving as an i128 or a string comes back
     * from scValToNative as a bigint or a string, and every `<` and `>` against a number is then
     * false or NaN: the bound would still be written here and would not be a bound. */
    if (typeof slots !== "number" || !Number.isInteger(slots)) {
      throw new PublicRefusal("a group link's share count must be a whole number");
    }
    const maxSlots = maxPoolSlots(config.network);
    if (slots < MIN_POOL_SLOTS || slots > maxSlots) {
      throw new PublicRefusal(`a group link holds between ${MIN_POOL_SLOTS} and ${maxSlots} shares`);
    }
    /* And the minimum is PER SHARE, not per pot. `checkCaps` applies MIN_DROP_USDC to args[2],
     * which for a pool is the whole thing, so create_drop(amount = 0.01 USDC, slots = 30) clears
     * the contract (it asks only for amount >= slots) and clears the caps, while buying thirty
     * sponsored accounts, about 45 XLM of reserve, for one cent. The floor exists because the
     * reserve per account does not scale with the amount; it has to be applied where the accounts
     * are counted. */
    if (amountStroops / BigInt(slots) < caps.minDropStroops) {
      throw new PublicRefusal(
        `each share is below the minimum we will sponsor (${stroopsToUsdc(caps.minDropStroops)} USDC)`,
      );
    }
  }

  const server = (deps.rpc ?? defaultRpc)(config.sorobanRpcUrl);

  /* Simulate BEFORE the sponsor pays for anything and BEFORE the day's budget is touched, exactly
   * as /v2-reclaim does (D3 item a). A deposit the contract would reject (paused, a bad expiry, a
   * sender without the USDC) used to be fee-bumped unread and billed to the sponsor when it failed
   * on-ledger; a simulation that fails costs nothing and is refused here. The reason stays an
   * ordinary Error: on mainnet it is redacted to a reference, because the contract's refusal text
   * is an oracle on the caller's own account state and the validator, not a product rule.
   *
   * Soroban RPC `simulateTransaction` (developers.stellar.org/docs/data/apis/rpc/api-reference/
   * methods/simulateTransaction): an error answer carries `error`; a success carries
   * `minResourceFee` as a string of stroops. Both as the SDK parses them (rpc.Api.*). */
  const sim = await server.simulateTransaction(inner);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`v2-deposit would fail: ${sim.error}`);
  /* And the fee is what the invoke needs, not what the caller wrote. The inner fee is signed by
   * the sender and cannot be lowered here, so an inflated one is refused instead. A simulation
   * that names no numeric resource fee is refused too: `x > NaN` is false, so the bound would
   * otherwise fail open and the 2 XLM cap would be the only one left. */
  const needed = Number.parseInt(sim.minResourceFee, 10) + DEPOSIT_INCLUSION_HEADROOM;
  if (!Number.isFinite(needed)) throw new Error("v2-deposit simulation named no resource fee");
  if (Number.parseInt(inner.fee, 10) > needed) {
    throw new Error(`inner fee ${inner.fee} exceeds what the deposit needs (${needed})`);
  }
  refuseOversizedResourceFee(inner, "v2-deposit");

  // The day cap and the per-SENDER day cap (D3 item k), reserved together and released together.
  const cap = await checkCaps(amountStroops, caps, Date.now(), input.senderPublicKey);
  if (!cap.ok) throw new PublicRefusal(`canary cap: ${cap.reason}`);

  /* The day's budget goes back at most ONCE, and never once the transaction is on the network.
   * Before this, a send ERROR or an on-ledger FAILED released the cap and then threw into the
   * catch below, which released it again: every failed deposit handed back twice its amount, and
   * the counter (a plain KV integer) could run negative, which is a day cap that no longer caps.
   * The catch also fired for an RPC that died mid-poll AFTER the transaction was accepted, giving
   * back the budget for a deposit that then landed, and a send that THREW was handled as if it had
   * never been sent although the RPC may have queued it. test-soroban-relay.ts counts the releases
   * per branch (ERROR 1, FAILED 1, TRY_AGAIN_LATER 1, send refused outright 1, NOT_FOUND 0, mid-poll
   * throw 0, send THROW 0) so this stays locked. */
  let released = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await cap.release?.();
  };

  try {
    // The sponsor pays the inner's inclusion + Soroban resource fee, at the smallest base the SDK
    // accepts (`feeBumpBase`).
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      config.sponsorAccountId,
      feeBumpBase(inner),
      inner,
      config.networkPassphrase,
    );
    refuseInflatedBid(feeBump, inner, "v2-deposit");
    /* Charge, sign, send and watch (`payAndSubmit`). It throws a plain Error, or RelayBusyError
     * (503), only when nothing reached the network: the fee budget refused, the signer threw, the
     * send was refused outright, ERROR, or TRY_AGAIN_LATER. Those are the branches that can
     * honestly say the money did not move, and the catch below gives the cap back for them. */
    const { hash, got } = await payAndSubmit(server, signer, feeBump, "v2-deposit", deps, {
      pollMs: V2_SUBMIT_POLL_MS,
      maxPolls: V2_SUBMIT_MAX_POLLS,
    });

    if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash, confirmed: true };

    // FAILED is a definitive on-ledger rejection — the deposit did not take effect, so the day's
    // budget goes back. (The fee does not: an included transaction pays its fee whatever it did.)
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) {
      await releaseOnce();
      throw new Error(`v2-deposit tx ${got.status}`);
    }

    /* Still NOT_FOUND after the poll window. This used to throw, and the catch below released the
     * cap with the comment "the deposit never landed" — but we do not know that. The transaction
     * was accepted for inclusion; the RPC simply has not shown it to us yet, which is ordinary
     * under congestion. Reporting that as a failure is what made the client tell the user "your
     * money hasn't moved. Try again." for a deposit that then landed a moment later, and a retry
     * mints a SECOND drop under a fresh link key — real money gone twice.
     *
     * So: say we could not confirm, hand back the hash, and keep the budget reserved. The caller
     * settles it against the escrow, which is the only authority on whether the drop exists. */
    return { hash, confirmed: false };
  } catch (e) {
    /* Everything that never reached the network (a fault before the send, a send refused outright,
     * ERROR, TRY_AGAIN_LATER) and the definitive FAILED above give the budget back, once. Only an
     * UNDECIDED submission keeps the reservation: a send that went unanswered, or an RPC that
     * stopped answering while the transaction was being watched, may still land. */
    if (!isSubmitUnconfirmed(e)) await releaseOnce();
    throw e;
  }
}

/**
 * /v2-reclaim — gasless v2 reclaim relayer (C2 recovery lever for v2 drops). After a drop's
 * `expiry`, the ORIGINAL sender reclaims their OWN unclaimed drop: they build + sign a
 * `reclaim` / `reclaim_pool` invoke (the contract does `sender.require_auth()`, satisfied by
 * the sender being the inner tx source); the sponsor FEE-BUMPS it so the sender pays no gas.
 * The contract only returns funds to the recorded sender — the relayer can never redirect a
 * stroop (mirror of /v2-deposit; the SEPARATE tight allowlist never widens the claim/deposit
 * ones). This is v2's equivalent of the classic /feebump sender-reclaim (spike9).
 */
export async function relayReclaimHandler(
  config: SponsorConfig,
  signer: SponsorSigner,
  input: RelayDepositInput,
  deps: RelayDeps = {},
): Promise<RelayClaimResult> {
  if (!config.lumendropContract) throw new Error("v2 relayer not configured (LUMENDROP_CONTRACT unset)");
  const inner = TransactionBuilder.fromXDR(input.xdr, config.networkPassphrase) as Transaction;

  if (inner.source !== input.senderPublicKey) throw new Error(`unexpected inner source ${shortKey(inner.source)}`);
  if (inner.operations.length !== 1) throw new Error("reclaim tx must have exactly 1 op");
  const op = inner.operations[0] as { type: string; func?: xdr.HostFunction };
  if (op.type !== "invokeHostFunction" || !op.func) throw new Error("not a contract invoke");
  if (op.func.switch().name !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  const ic = op.func.invokeContract();
  const calledContract = Address.fromScAddress(ic.contractAddress()).toString();
  const calledFn = ic.functionName().toString();
  // Exits may target a superseded contract (a drop is only ever released by the contract that
  // holds it); `exitContract` throws for anything that is not one of ours.
  exitContract(config, calledContract);
  if (!ALLOWED_RECLAIM_METHODS.has(calledFn)) {
    throw new Error(`only reclaim/reclaim_pool is relayed here, got '${calledFn}'`);
  }
  if (Number.parseInt(inner.fee, 10) > V2_DEPOSIT_FEE_CAP) {
    throw new Error(`inner fee ${inner.fee} exceeds cap ${V2_DEPOSIT_FEE_CAP}`);
  }

  const server = (deps.rpc ?? defaultRpc)(config.sorobanRpcUrl);

  /* Simulate BEFORE the sponsor pays for anything, exactly as /v2-claim does. Until now this
   * route fee-bumped whatever it was handed: a `reclaim` the contract would reject (not expired,
   * not the sender's, already claimed) is still included and still charged, so any account holder
   * could bill the sponsor up to the fee cap per request, thirty times a minute per address, with
   * no drop of their own involved. A simulation that fails costs nothing and is refused here. A
   * simulation that succeeds bounds the route by construction: the contract only releases a drop
   * to the sender who made it, once, so the sponsor pays at most one fee per drop that sender was
   * allowed (and capped) to create. */
  const sim = await server.simulateTransaction(inner);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`v2-reclaim would fail: ${sim.error}`);
  /* And the fee is what the invoke needs, not what the caller wrote. The inner fee is signed by
   * the sender and cannot be lowered here, so an inflated one is refused instead. The headroom is
   * the client's own inclusion fee (0.2 XLM, lib/lumendrop.ts) plus a little slack; a simulation
   * whose resource fee moved between the client's run and ours still fits. */
  const needed = Number.parseInt(sim.minResourceFee, 10) + V2_RECLAIM_INCLUSION_HEADROOM;
  // `x > NaN` is false: a simulation with no numeric resource fee must refuse, not fail open.
  if (!Number.isFinite(needed)) throw new Error("v2-reclaim simulation named no resource fee");
  if (Number.parseInt(inner.fee, 10) > needed) {
    throw new Error(`inner fee ${inner.fee} exceeds what the reclaim needs (${needed})`);
  }
  refuseOversizedResourceFee(inner, "v2-reclaim");

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    config.sponsorAccountId,
    feeBumpBase(inner),
    inner,
    config.networkPassphrase,
  );
  refuseInflatedBid(feeBump, inner, "v2-reclaim");
  // Charge the bid, sign, send and watch: the same single step every relay uses (`payAndSubmit`).
  const { hash, got } = await payAndSubmit(server, signer, feeBump, "v2-reclaim", deps, {
    pollMs: V2_SUBMIT_POLL_MS,
    maxPolls: V2_SUBMIT_MAX_POLLS,
  });
  if (got.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`v2-reclaim tx ${got.status}`);
  if (got.status === rpc.Api.GetTransactionStatus.SUCCESS) return { hash, confirmed: true };
  /* NOT_FOUND after the window: accepted, undecided. A reclaim reported as failed is retried by
   * the sender's screen, and the contract refuses the second one (the drop is gone), which the
   * sender then reads as "my money is stuck"; 202 with the hash lets the screen read the ledger. */
  return { hash, confirmed: false };
}
