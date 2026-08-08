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
import { rpc, Address, Contract, TransactionBuilder, scValToNative, xdr, type Transaction, type FeeBumpTransaction } from "@stellar/stellar-sdk";
import { capsFromEnv, checkCaps } from "./caps.js";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { CHANNEL_LEASE_TTL_SECONDS, type ChannelManager } from "./channels.js";

const ALLOWED_METHODS = new Set<string>(["claim", "claim_share"]);
/** The two reclaim methods a sender may relay to recover their OWN unclaimed drop after expiry. */
const ALLOWED_RECLAIM_METHODS = new Set<string>(["reclaim", "reclaim_pool"]);
/** Max fee (stroops) the sponsor will fee-bump a v2 deposit to (~2 XLM; a deposit costs ~0.2). */
const V2_DEPOSIT_FEE_CAP = 20_000_000;

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
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function relayClaimHandler(
  config: SponsorConfig,
  signer: SponsorSigner,
  input: RelayClaimInput,
  channels?: ChannelManager,
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

  const server = new rpc.Server(config.sorobanRpcUrl);

  // C1: like /create-account, the sponsor-sourced submit serializes concurrent v2 claims
  // on the sponsor's ONE sequence. Lease a CHANNEL to source the tx (its own sequence)
  // and FEE-BUMP with the sponsor — the sponsor stays the fee source, the channel only
  // lends its sequence. This path SERVER-submits, so the lease is released as soon as the
  // tx confirms (high reuse). No channel/lease ⇒ the sponsor-sourced fallback.
  const lease = channels?.enabled ? await channels.lease() : null;
  try {
    const sourcePub = lease ? lease.publicKey : signer.publicKey();
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
      prepared.sign(lease.keypair); // channel = tx source (lends its sequence)
      // Fee-bump so the SPONSOR pays the Soroban fee (mirrors /v2-deposit). prepared.fee
      // already covers inclusion + resource fee; the fee-bump per-op floor requires ≥ it.
      const feeBump = TransactionBuilder.buildFeeBumpTransaction(
        signer.publicKey(),
        prepared.fee,
        prepared,
        config.networkPassphrase,
      );
      await signer.sign(feeBump);
      submitTx = feeBump;
    } else {
      await signer.sign(prepared); // sponsor = tx source (fallback)
      submitTx = prepared;
    }

    const sent = await server.sendTransaction(submitTx);
    if (sent.status === "ERROR") throw new Error(`v2-claim send failed: ${JSON.stringify(sent.errorResult)}`);
    // Confirm-wait is bounded to V2_CLAIM_TIMEOUT_SECONDS (= the tx timebound) so a tx not
    // yet in a ledger by then is already tx_too_late; the lease is freed only after this.
    const maxPolls = Math.ceil((V2_CLAIM_TIMEOUT_SECONDS * 1000) / V2_CLAIM_POLL_MS);
    let got = await server.getTransaction(sent.hash);
    for (let i = 0; i < maxPolls && got.status === "NOT_FOUND"; i++) {
      await sleep(V2_CLAIM_POLL_MS);
      got = await server.getTransaction(sent.hash);
    }
    if (got.status !== "SUCCESS") throw new Error(`v2-claim tx ${got.status}`);
    return { hash: sent.hash };
  } finally {
    // Server-submit path: the channel is free the instant this claim settles/fails.
    if (lease) await lease.release();
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
 * single `deposit` invoke on the KNOWN LumenDrop contract, sourced by the sender, under the fee cap.
 */
export async function relayDepositHandler(
  config: SponsorConfig,
  signer: SponsorSigner,
  input: RelayDepositInput,
): Promise<RelayClaimResult> {
  if (!config.lumendropContract) throw new Error("v2 relayer not configured (LUMENDROP_CONTRACT unset)");
  const inner = TransactionBuilder.fromXDR(input.xdr, config.networkPassphrase) as Transaction;

  if (inner.source !== input.senderPublicKey) throw new Error(`unexpected inner source ${inner.source}`);
  if (inner.operations.length !== 1) throw new Error("deposit tx must have exactly 1 op");
  const op = inner.operations[0] as { type: string; func?: xdr.HostFunction };
  if (op.type !== "invokeHostFunction" || !op.func) throw new Error("not a contract invoke");
  if (op.func.switch().name !== "hostFunctionTypeInvokeContract") throw new Error("not a contract call");
  const ic = op.func.invokeContract();
  const calledContract = Address.fromScAddress(ic.contractAddress()).toString();
  const calledFn = ic.functionName().toString();
  // NEW escrow only ever goes into the CURRENT contract (the legacy one is read/exit-only).
  if (calledContract !== config.lumendropContract) throw new Error("wrong contract");
  if (calledFn !== "deposit") throw new Error(`only 'deposit' is relayed here, got '${calledFn}'`);
  if (Number.parseInt(inner.fee, 10) > V2_DEPOSIT_FEE_CAP) {
    throw new Error(`inner fee ${inner.fee} exceeds cap ${V2_DEPOSIT_FEE_CAP}`);
  }

  // Canary caps — `deposit(from, link, amount, expiry)`, so the escrowed amount is arg 2.
  // Reading it from the XDR (not from a client-supplied field) means the cap is enforced on
  // what the ledger will actually execute.
  const args = ic.args();
  if (args.length !== 4) throw new Error(`deposit expects 4 args, got ${args.length}`);
  const amountStroops = BigInt(scValToNative(args[2]!) as bigint | number | string);
  const cap = await checkCaps(amountStroops, capsFromEnv());
  if (!cap.ok) throw new Error(`canary cap: ${cap.reason}`);

  try {
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      signer.publicKey(),
      inner.fee, // covers the inner's inclusion + Soroban resource fee (paid by the sponsor)
      inner,
      config.networkPassphrase,
    );
    await signer.sign(feeBump);

    const server = new rpc.Server(config.sorobanRpcUrl);
    const sent = await server.sendTransaction(feeBump);
    if (sent.status === "ERROR") throw new Error(`v2-deposit send failed: ${JSON.stringify(sent.errorResult)}`);
    let got = await server.getTransaction(sent.hash);
    for (let i = 0; i < 40 && got.status === "NOT_FOUND"; i++) {
      await sleep(1500);
      got = await server.getTransaction(sent.hash);
    }
    if (got.status !== "SUCCESS") throw new Error(`v2-deposit tx ${got.status}`);
    return { hash: sent.hash };
  } catch (e) {
    await cap.release?.(); // the deposit never landed — give the day's budget back
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
): Promise<RelayClaimResult> {
  if (!config.lumendropContract) throw new Error("v2 relayer not configured (LUMENDROP_CONTRACT unset)");
  const inner = TransactionBuilder.fromXDR(input.xdr, config.networkPassphrase) as Transaction;

  if (inner.source !== input.senderPublicKey) throw new Error(`unexpected inner source ${inner.source}`);
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

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    signer.publicKey(),
    inner.fee,
    inner,
    config.networkPassphrase,
  );
  await signer.sign(feeBump);

  const server = new rpc.Server(config.sorobanRpcUrl);
  const sent = await server.sendTransaction(feeBump);
  if (sent.status === "ERROR") throw new Error(`v2-reclaim send failed: ${JSON.stringify(sent.errorResult)}`);
  let got = await server.getTransaction(sent.hash);
  for (let i = 0; i < 40 && got.status === "NOT_FOUND"; i++) {
    await sleep(1500);
    got = await server.getTransaction(sent.hash);
  }
  if (got.status !== "SUCCESS") throw new Error(`v2-reclaim tx ${got.status}`);
  return { hash: sent.hash };
}
