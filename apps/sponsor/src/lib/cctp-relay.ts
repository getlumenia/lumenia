/**
 * /cctp-relay: the sponsor relays Circle CCTP V2 mints INTO Stellar (hackathon build, 2026-09-19,
 * decision register D27 item 2.3; Circle CCTP is the primary partner, D7).
 *
 * THE FLOW. A sender on Base burns USDC with `depositForBurnWithHook`, naming the Stellar
 * CctpForwarder as both `mintRecipient` and `destinationCaller` and the Lumenia account in the
 * hook data. Circle's Iris service attests the burn. Someone must then call
 * `mint_and_forward(message, attestation)` on the forwarder, which mints the USDC and forwards it
 * to the account in the hook. Circle's own forwarding service does not serve Stellar as a
 * destination, so that someone is us: this route. Proven by script twice on 2026-09-19 before this
 * route existed (Standard: mint a5c4eae0...4a4d; Fast: mint 617908c7...1261, 18 s burn to mint).
 *
 * WHY THE SPONSOR CAN SAFELY PAY FOR THIS. The call is permissionless and moves no sponsor value:
 * the forwarder mints Circle's USDC to the recipient the BURN named, verified against Circle's
 * attesters inside the contract. The sponsor only pays the Soroban fee. So the guard here is about
 * the fee, not the money, and it is tight on purpose:
 *   1. Test network only (the Worker refuses the route on mainnet too; no mainnet forwarder is
 *      decided and the mainnet sponsor must never pay for this before one is).
 *   2. The contract and the method are CONSTANTS here, never taken from the request.
 *   3. The request names only a burn transaction hash. The message and the attestation are fetched
 *      by the sponsor itself from Circle's Iris, so a caller cannot hand us bytes to pay for.
 *   4. The message header is checked before any simulation: source domain on the allowlist,
 *      destination domain Stellar (27), destination caller = the forwarder. Anything else would
 *      fail in the contract anyway; refusing it first costs nothing.
 *   5. Simulation before signing (a replayed or forged attestation fails there, free), a fee
 *      ceiling, the channel-lease + sponsor fee-bump path of /v2-claim, a bounded confirm, and the
 *      kill switch and rate limit in the Worker.
 */
import { rpc, Contract, StrKey, TransactionBuilder, xdr, type Transaction, type FeeBumpTransaction } from "@stellar/stellar-sdk";
import type { SponsorConfig } from "./config.js";
import type { SponsorSigner } from "./signer.js";
import { isSubmitUnconfirmed } from "./stellar.js";
import { feeBumpBase, payAndSubmit, simErrorHead, type RelayDeps, type RelayRpc } from "./soroban-relay.js";
import { CHANNEL_LEASE_TTL_SECONDS, type ChannelManager } from "./channels.js";

/** Circle's CctpForwarder on Stellar testnet (developers.circle.com, CCTP on Stellar). */
export const CCTP_TESTNET_FORWARDER = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
/** The only forwarder ids this module will ever call. */
export const CCTP_FORWARDERS = new Set<string>([CCTP_TESTNET_FORWARDER]);
export const CCTP_METHOD = "mint_and_forward";
export const CCTP_STELLAR_DOMAIN = 27;
/** Source chains whose burns we relay. 6 = Base (Sepolia on testnet). */
export const CCTP_SOURCE_DOMAINS = new Set<number>([6]);
export const CCTP_IRIS_SANDBOX = "https://iris-api-sandbox.circle.com";

/** CCTP V2 message header: version 4, source 4, dest 4, nonce 32, sender 32, recipient 32, caller 32, min 4, executed 4. */
const HEADER_BYTES = 148;
/** A generous ceiling; a hook-carrying burn message measured 464 bytes. */
const MESSAGE_MAX_BYTES = 2048;
/** Attestations are 65-byte ECDSA signatures, concatenated; the sandbox sends 2 (130 bytes). */
const SIG_BYTES = 65;
const MAX_SIGS = 8;
/** The sponsor's fee ceiling for one relayed mint (stroops). Measured resource fees: 94,046 and 139,639. */
export const CCTP_FEE_CAP = 20_000_000;

const TIMEOUT_SECONDS = 60;
const POLL_MS = 1500;
if (TIMEOUT_SECONDS >= CHANNEL_LEASE_TTL_SECONDS) throw new Error("cctp-relay timeout must be < channel lease TTL");

export interface CctpHeader {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: string;
  destinationCaller: string;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

export function parseCctpHeader(message: Uint8Array): CctpHeader {
  if (message.length < HEADER_BYTES) throw new Error("cctp message too short");
  return {
    version: u32(message, 0),
    sourceDomain: u32(message, 4),
    destinationDomain: u32(message, 8),
    nonce: hex(message.subarray(12, 44)),
    destinationCaller: hex(message.subarray(108, 140)),
    minFinalityThreshold: u32(message, 140),
    finalityThresholdExecuted: u32(message, 144),
  };
}

/** Throws unless this message is one the sponsor should pay to mint. No network, no cost. */
export function checkCctpMessage(message: Uint8Array, attestation: Uint8Array, forwarder: string): CctpHeader {
  if (message.length > MESSAGE_MAX_BYTES) throw new Error("cctp message too long");
  if (attestation.length === 0 || attestation.length % SIG_BYTES !== 0 || attestation.length > SIG_BYTES * MAX_SIGS) {
    throw new Error("cctp attestation has the wrong length");
  }
  const h = parseCctpHeader(message);
  if (h.destinationDomain !== CCTP_STELLAR_DOMAIN) throw new Error(`cctp message is not for Stellar (domain ${h.destinationDomain})`);
  if (!CCTP_SOURCE_DOMAINS.has(h.sourceDomain)) throw new Error(`cctp source domain ${h.sourceDomain} not allowed`);
  const caller = hex(StrKey.decodeContract(forwarder));
  if (h.destinationCaller !== caller) throw new Error("cctp message does not name the forwarder as its caller");
  return h;
}

export type IrisLookup =
  | { status: "pending"; detail: string }
  | { status: "complete"; message: Uint8Array; attestation: Uint8Array };

const fromHex = (s: string) => new Uint8Array(Buffer.from(s.replace(/^0x/, ""), "hex"));

/** One read of Circle's Iris for a burn. Never waits: the caller polls the route instead. */
export async function fetchAttestation(
  irisUrl: string,
  sourceDomain: number,
  burnTxHash: string,
  fetchImpl: typeof fetch = fetch,
): Promise<IrisLookup> {
  const url = `${irisUrl.replace(/\/$/, "")}/v2/messages/${sourceDomain}?transactionHash=${burnTxHash.toLowerCase()}`;
  const r = await fetchImpl(url);
  if (r.status === 404) return { status: "pending", detail: "Circle has not indexed this burn yet" };
  if (!r.ok) throw new Error(`Circle attestation service answered ${r.status}`);
  const body = (await r.json()) as { messages?: Array<{ status?: string; message?: string; attestation?: string }> };
  const m = body.messages?.[0];
  if (!m) return { status: "pending", detail: "Circle has not indexed this burn yet" };
  if (m.status !== "complete" || !m.message || !m.attestation || !/^0x[0-9a-fA-F]+$/.test(m.attestation) || !/^0x[0-9a-fA-F]+$/.test(m.message)) {
    return { status: "pending", detail: `Circle attestation ${m.status ?? "pending"}` };
  }
  return { status: "complete", message: fromHex(m.message), attestation: fromHex(m.attestation) };
}

export interface CctpRelayInput {
  burnTxHash: string;
  sourceDomain?: number;
}

export type CctpRelayResult =
  | { status: "pending"; detail: string }
  /** `confirmed: false` = accepted by the RPC, not observed to land before the poll window closed (202). */
  | { status: "minted"; hash: string; nonce: string; confirmed: boolean };

export async function relayCctpHandler(
  config: SponsorConfig,
  signer: SponsorSigner,
  input: CctpRelayInput,
  opts: { forwarder?: string; irisUrl?: string; fetchImpl?: typeof fetch; channels?: ChannelManager; relay?: RelayDeps } = {},
): Promise<CctpRelayResult> {
  if (config.network !== "testnet") throw new Error("the CCTP relay is testnet-only");
  const forwarder = opts.forwarder ?? "";
  if (!CCTP_FORWARDERS.has(forwarder)) throw new Error("cctp relay not configured (CCTP_FORWARDER unset or unknown)");
  if (!/^0x[0-9a-fA-F]{64}$/.test(input.burnTxHash ?? "")) throw new Error("burnTxHash must be a 0x-prefixed 32-byte hash");
  const domain = input.sourceDomain ?? 6;
  if (!CCTP_SOURCE_DOMAINS.has(domain)) throw new Error(`cctp source domain ${domain} not allowed`);

  const found = await fetchAttestation(opts.irisUrl ?? CCTP_IRIS_SANDBOX, domain, input.burnTxHash, opts.fetchImpl);
  if (found.status === "pending") return found;
  const header = checkCctpMessage(found.message, found.attestation, forwarder);

  const relay = opts.relay ?? {};
  const server: RelayRpc = relay.rpc ? relay.rpc(config.sorobanRpcUrl) : new rpc.Server(config.sorobanRpcUrl);
  const lease = opts.channels?.enabled ? await opts.channels.lease() : null;
  // An undecided mint may still land on this channel's sequence within its timebound: keep the
  // lease and let its TTL lapse, exactly as the claim relay does (soroban-relay.ts).
  let keepLease = false;
  try {
    const source = await server.getAccount(lease ? lease.publicKey : config.sponsorAccountId);
    const tx = new TransactionBuilder(source, { fee: "1000000", networkPassphrase: config.networkPassphrase })
      .addOperation(new Contract(forwarder).call(CCTP_METHOD, xdr.ScVal.scvBytes(Buffer.from(found.message)), xdr.ScVal.scvBytes(Buffer.from(found.attestation))))
      .setTimeout(TIMEOUT_SECONDS)
      .build();

    // A replayed nonce or a forged attestation fails here, before anything is signed or paid. The
    // reason carries the error's first line only: the event log after it replays the call's
    // arguments (the burn message, which names the recipient and the amount).
    const sim = await server.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`cctp-relay simulation failed (already minted, or not mintable): ${simErrorHead(sim.error)}`);
    }
    const prepared = rpc.assembleTransaction(tx, sim).build();
    if (Number.parseInt(prepared.fee, 10) > CCTP_FEE_CAP) throw new Error(`cctp-relay fee ${prepared.fee} exceeds cap ${CCTP_FEE_CAP}`);

    let submitTx: Transaction | FeeBumpTransaction;
    if (lease) {
      prepared.sign(lease.keypair); // the channel lends its sequence; the inner leaves only fee-bumped
      submitTx = TransactionBuilder.buildFeeBumpTransaction(config.sponsorAccountId, feeBumpBase(prepared), prepared, config.networkPassphrase);
    } else {
      submitTx = prepared;
    }

    // Charge the bid, sign, send and watch: the same single step as the LumenDrop relays, so the
    // fee budget, the busy answer and the undecided answer cannot drift between them. One
    // subrequest is reserved for the lease release (lib/subrequests.ts).
    const { hash, got, cut } = await payAndSubmit(server, signer, submitTx, "cctp-relay", relay, {
      pollMs: POLL_MS,
      maxPolls: Math.ceil((TIMEOUT_SECONDS * 1000) / POLL_MS),
      reserve: 1,
    });
    // A window the subrequest budget closed before the timebound: the mint may still land on this
    // channel's sequence, so the lease is kept and left to lapse (the claim relay does the same).
    if (cut && got.status === rpc.Api.GetTransactionStatus.NOT_FOUND) keepLease = true;
    if (got.status === rpc.Api.GetTransactionStatus.FAILED) throw new Error(`cctp-relay tx ${got.status}`);
    /* NOT_FOUND after the window is "accepted, undecided", not "failed": a mint reported as failed
     * would be relayed again by the client and refused by the forwarder as a replayed nonce, with
     * the first one landing anyway. The worker answers 202 for confirmed:false. */
    return { status: "minted", hash, nonce: header.nonce, confirmed: got.status === rpc.Api.GetTransactionStatus.SUCCESS };
  } catch (e) {
    /* An undecided mint (the send went unanswered, or the RPC died while it was watched) is the
     * same "submitted, not yet confirmed" as NOT_FOUND above, and gets the same body. It used to
     * surface as the generic {error: "submit unconfirmed"}, which the add-money page read as
     * Circle still attesting; it then asked again, and a second mint was signed and charged for a
     * burn already minting. One 202 body for "submitted" is what lets the page say the truth. */
    if (isSubmitUnconfirmed(e)) {
      keepLease = true;
      const hash = (e as { hash?: string }).hash;
      if (hash) return { status: "minted", hash, nonce: header.nonce, confirmed: false };
    }
    throw e;
  } finally {
    if (lease && !keepLease) await lease.release();
  }
}
