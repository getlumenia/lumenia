/**
 * Circle CCTP V2 inbound, the browser half (hackathon build, 2026-09-19; D27 item 2.3, Circle is
 * the primary partner, D7). A sender holding USDC on Base burns it with a hook that names their
 * Lumenia account; Circle attests; our sponsor relays the mint on Stellar (`POST /cctp-relay`,
 * apps/sponsor/src/lib/cctp-relay.ts) and the USDC lands in the account, ready to leave as a link.
 *
 * TEST NETWORK ONLY: Base Sepolia -> Stellar testnet, Circle's testnet CctpForwarder.
 *
 * The functions take viem clients rather than `window.ethereum`, so the same code runs in the page
 * (an injected wallet) and in the Node live test (a local key), and the fund-loss-critical bytes are
 * checked offline in cctp.selftest.ts against the encoding that minted on 2026-09-19:
 *   - `mintRecipient` AND `destinationCaller` are both the forwarder contract's 32 bytes, so only
 *     the forwarder can mint and it mints to itself first;
 *   - the hook is 24 zero bytes, a u32 version 0, a u32 length, then the recipient's strkey as text,
 *     which is where the forwarder sends the USDC. A wrong byte here strands the money.
 */
import { StrKey } from "@stellar/stellar-sdk";
import type { Hex, PublicClient, WalletClient } from "viem";

export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BASE_SEPOLIA_DOMAIN = 6;
export const STELLAR_DOMAIN = 27;
export const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
export const BASE_SEPOLIA_TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
export const STELLAR_TESTNET_FORWARDER = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
/** 1000 = Fast (seconds on the sandbox, a small fee), 2000 = Standard (source-chain finality, no fee). */
export const FAST_FINALITY = 1000;
/**
 * Circle's published Fast fee for Base -> Stellar was 1.3 basis points on 2026-09-19 (the Iris
 * fee endpoint). We allow 2, so a small change does not downgrade the transfer to Standard; the
 * fee actually taken is Circle's, not this ceiling (1 USDC arrived as 0.99987).
 */
export const FAST_FEE_CEILING_BPS = 2n;

export const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export const TOKEN_MESSENGER_V2_ABI = [
  {
    name: "depositForBurnWithHook",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;

/** The forwarder contract id as the 32 bytes CCTP calls a "bytes32 address". */
export function forwarderBytes32(forwarder = STELLAR_TESTNET_FORWARDER): Hex {
  return toHex(new Uint8Array(StrKey.decodeContract(forwarder)));
}

/** Circle's forwarder hook: 24 zero bytes, u32 version 0, u32 length, the recipient strkey. */
export function buildForwarderHookData(recipient: string): Hex {
  const valid = StrKey.isValidEd25519PublicKey(recipient) || StrKey.isValidContract(recipient) || StrKey.isValidMed25519PublicKey(recipient);
  if (!valid) throw new Error("that is not a Stellar account address");
  const text = new TextEncoder().encode(recipient);
  const hook = new Uint8Array(32 + text.length);
  const view = new DataView(hook.buffer);
  view.setUint32(24, 0, false);
  view.setUint32(28, text.length, false);
  hook.set(text, 32);
  return toHex(hook);
}

/** USDC has 6 decimals on Base. "2" -> 2_000_000n. Refuses more than 6 decimals rather than rounding. */
export function parseUsdc6(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) throw new Error("enter an amount like 2 or 2.50");
  const units = BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
  if (units <= 0n) throw new Error("enter an amount above zero");
  return units;
}

/** The most we let Circle take for Fast finality, rounded up, never zero. */
export function fastMaxFee(units: bigint): bigint {
  return (units * FAST_FEE_CEILING_BPS + 9_999n) / 10_000n + 1n;
}

export interface BurnProgress {
  (step: "approving" | "approved" | "burning" | "burned", hash?: Hex): void;
}

/**
 * Approve (if needed) and burn on Base Sepolia, naming `recipient` (a Lumenia G account) in the hook.
 * Simulates before sending, so a revert costs nothing and names its reason. Returns the burn hash.
 */
export async function burnToStellar(opts: {
  wallet: WalletClient;
  publicClient: PublicClient;
  account: Hex;
  recipient: string;
  units: bigint;
  finality?: number;
  onProgress?: BurnProgress;
}): Promise<Hex> {
  const { wallet, publicClient, account, recipient, units } = opts;
  const finality = opts.finality ?? FAST_FINALITY;
  const hookData = buildForwarderHookData(recipient);
  const forwarder32 = forwarderBytes32();
  const maxFee = finality === FAST_FINALITY ? fastMaxFee(units) : 0n;
  // The wallet's own account object when it has one: a local key in the Node live test, a JSON-RPC
  // account for an injected wallet. A bare address would make viem ask the RPC to sign, which only
  // an injected wallet can do.
  const signer = wallet.account ?? account;

  const allowance = (await publicClient.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20_ABI, functionName: "allowance", args: [account, BASE_SEPOLIA_TOKEN_MESSENGER_V2] })) as bigint;
  if (allowance < units) {
    opts.onProgress?.("approving");
    const h = await wallet.writeContract({
      account: signer,
      chain: wallet.chain,
      address: BASE_SEPOLIA_USDC,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [BASE_SEPOLIA_TOKEN_MESSENGER_V2, units],
    });
    const rc = await publicClient.waitForTransactionReceipt({ hash: h });
    if (rc.status !== "success") throw new Error("the approval was reverted on Base");
    opts.onProgress?.("approved", h);
    // A load-balanced RPC can answer the next read from a node one block behind the receipt.
    for (let i = 0; i < 30; i++) {
      const a = (await publicClient.readContract({ address: BASE_SEPOLIA_USDC, abi: ERC20_ABI, functionName: "allowance", args: [account, BASE_SEPOLIA_TOKEN_MESSENGER_V2] })) as bigint;
      if (a >= units) break;
      if (i === 29) throw new Error("the approval never became visible on Base");
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  opts.onProgress?.("burning");
  const { request } = await publicClient.simulateContract({
    account: signer,
    address: BASE_SEPOLIA_TOKEN_MESSENGER_V2,
    abi: TOKEN_MESSENGER_V2_ABI,
    functionName: "depositForBurnWithHook",
    args: [units, STELLAR_DOMAIN, forwarder32, BASE_SEPOLIA_USDC, forwarder32, maxFee, finality, hookData],
  });
  const burn = await wallet.writeContract({ ...request, chain: wallet.chain });
  const rc = await publicClient.waitForTransactionReceipt({ hash: burn });
  if (rc.status !== "success") throw new Error("the burn was reverted on Base");
  opts.onProgress?.("burned", burn);
  return burn;
}

export type RelayState = { status: "pending"; detail: string } | { status: "minted"; hash: string };

/** One ask of our sponsor to relay the mint. 202 = Circle has not attested yet; ask again. */
export async function askRelay(sponsorUrl: string, burnTxHash: string, fetchImpl: typeof fetch = fetch): Promise<RelayState> {
  const r = await fetchImpl(`${sponsorUrl.replace(/\/$/, "")}/cctp-relay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ burnTxHash }),
  });
  const body = (await r.json().catch(() => ({}))) as { status?: string; hash?: string; detail?: string; error?: string };
  if (r.status === 202) return { status: "pending", detail: body.detail ?? "Circle is attesting the burn" };
  if (r.status === 200 && body.status === "minted" && body.hash) return { status: "minted", hash: body.hash };
  throw new Error(body.error ?? `the relay answered ${r.status}`);
}
