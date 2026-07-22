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

const RPC_URL = process.env.NEXT_PUBLIC_SOROBAN_RPC ?? "https://soroban-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const CONTRACT = process.env.NEXT_PUBLIC_LUMENDROP_CONTRACT ?? "CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF";
const UNIT = 10_000_000n; // 1 USDC = 1e7 stroops

const usdcStroops = (amount: string) => BigInt(Math.round(Number.parseFloat(amount) * Number(UNIT)));
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
}): Promise<V2Link> {
  const server = new rpc.Server(RPC_URL);
  const link = Keypair.random(); // ephemeral Ed25519 link key
  const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");
  const sender = opts.signer.publicKey();
  const expiry = BigInt(opts.expiry ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600);

  const source = await server.getAccount(sender);
  const tx = new TransactionBuilder(source, { fee: "2000000", networkPassphrase: NETWORK })
    .addOperation(
      new Contract(CONTRACT).call(
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

  // Gasless: the sponsor fee-bumps + submits the sender-signed inner (the sender pays no XLM).
  const base = opts.sponsorUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v2-deposit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ xdr: prepared.toXDR(), senderPublicKey: sender }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/v2-deposit → ${res.status}: ${text}`);
  const { hash } = JSON.parse(text) as { hash: string };

  const q = `a=${encodeURIComponent(opts.amount)}&s=${encodeURIComponent(opts.from)}`;
  const url = `${opts.webOrigin.replace(/\/$/, "")}/v2/c/${linkHex}?${q}#${link.secret()}`;
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
  sponsorUrl: string;
  /** true for a group-drop share (claim_share); false/undefined for a one-to-one claim */
  group?: boolean;
}): Promise<{ hash: string }> {
  const server = new rpc.Server(RPC_URL);
  const link = Keypair.fromSecret(opts.linkSecret);
  const linkHex = Buffer.from(link.rawPublicKey()).toString("hex");
  const kind = opts.group ? 2 : 1;
  const method = opts.group ? "claim_share" : "claim";

  // Read the EXACT bytes to sign from the contract (source = payout, which exists). No submit.
  const src = await server.getAccount(opts.payout);
  const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: NETWORK })
    .addOperation(
      new Contract(CONTRACT).call(
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

  const base = opts.sponsorUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/v2-claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, linkHex, payout: opts.payout, sigHex }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`/v2-claim → ${res.status}: ${text}`);
  return JSON.parse(text) as { hash: string };
}

const HORIZON_URL = "https://horizon-testnet.stellar.org";

/**
 * The walletless recipient path for the v2 UI: create a fresh account with a sponsored USDC
 * trustline (reusing the sponsor's /create-account — 0 XLM to the recipient), then claim the v2
 * drop straight into it via the relayer. Returns the new account + seed to persist locally.
 *
 * (A classic account needs a USDC trustline to hold the SAC balance — hence the sponsored
 * create-account; the trustline reserve is the sponsor's. The zero-reserve win fully lands once
 * the payout is a passkey smart-account contract, which holds the SAC with no trustline — v2.1.)
 */
export async function claimV2ToSponsoredAccount(opts: {
  linkSecret: string;
  sponsorUrl: string;
  group?: boolean;
}): Promise<{ hash: string; publicKey: string; seed: Uint8Array }> {
  const base = opts.sponsorUrl.replace(/\/$/, "");
  const horizon = new Horizon.Server(HORIZON_URL);
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
  const sandwich = TransactionBuilder.fromXDR(created.xdr, NETWORK) as Transaction;
  sandwich.sign(payout);
  await horizon.submitTransaction(sandwich);

  // 2. claim the v2 drop into the new account via the relayer (walletless + gasless).
  const { hash } = await claimV2({
    linkSecret: opts.linkSecret,
    payout: payout.publicKey(),
    sponsorUrl: opts.sponsorUrl,
    group: opts.group,
  });
  return { hash, publicKey: payout.publicKey(), seed: new Uint8Array(payout.rawSecretKey()) };
}

/* -------------------------- v2 reclaim (C2 recovery) -------------------------- */

export interface ReclaimableV2 {
  /** the drop id (32-byte link public key, hex) — pass to reclaimV2 */
  linkHex: string;
  usd: string;
  /** unix seconds the reclaim window opened (already past for a reclaimable drop) */
  expiry: number;
}

/** Read a drop's on-chain state via the contract's get_drop view (read-only simulation). */
async function readDrop(
  server: rpc.Server,
  sourceAccount: string,
  linkHex: string,
): Promise<{ amount: bigint; expiry: number; claimed: boolean } | null> {
  const src = await server.getAccount(sourceAccount);
  const view = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: NETWORK })
    .addOperation(new Contract(CONTRACT).call("get_drop", xdr.ScVal.scvBytes(Buffer.from(linkHex, "hex"))))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(view);
  if (rpc.Api.isSimulationError(sim)) return null;
  const val = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!val) return null;
  const d = scValToNative(val) as { amount?: bigint; expiry?: bigint | number; claimed?: boolean } | null;
  if (!d) return null; // None ⇒ the drop is gone (claimed or already reclaimed)
  return { amount: BigInt(d.amount ?? 0n), expiry: Number(d.expiry ?? 0), claimed: !!d.claimed };
}

/**
 * Your v2 sends that have come back: local `lumenia.sent` records whose drop is still on-chain,
 * UNCLAIMED, and past its expiry — so you can reclaim them gaslessly (reclaimV2). Reads
 * get_drop(link) per record (a read-only simulation); classic-CB ids (not 64-hex link keys) are
 * skipped, so this never double-counts the classic Horizon path (loadReclaimableSends).
 * `sender` is the user's home account (an existing account is needed as the simulation source).
 */
export async function loadReclaimableV2(sender: string): Promise<ReclaimableV2[]> {
  let records: Record<string, { balanceId?: string }>;
  try {
    records = JSON.parse(localStorage.getItem("lumenia.sent") ?? "{}") as Record<string, { balanceId?: string }>;
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
  const server = new rpc.Server(RPC_URL);
  const nowSec = Math.floor(Date.now() / 1000);
  // Parallel per-drop reads (bounded by the local send count) so the bell poll stays light.
  const results = await Promise.all(
    linkHexes.map(async (linkHex): Promise<ReclaimableV2 | null> => {
      try {
        const drop = await readDrop(server, sender, linkHex);
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
  const server = new rpc.Server(RPC_URL);
  const sender = opts.signer.publicKey();
  const method = opts.group ? "reclaim_pool" : "reclaim";
  const source = await server.getAccount(sender);
  const tx = new TransactionBuilder(source, { fee: "2000000", networkPassphrase: NETWORK })
    .addOperation(new Contract(CONTRACT).call(method, xdr.ScVal.scvBytes(Buffer.from(opts.linkHex, "hex"))))
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
