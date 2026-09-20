/**
 * ============================================================================
 *  SPIKE #7 — CCTP V2 INBOUND: Base Sepolia -> Stellar testnet via the CctpForwarder (T-PRE-6)
 * ============================================================================
 *
 *  GOAL. Prove the leg the hackathon's primary partner story rests on: a sender holding USDC on
 *  another chain funds a Lumenia account on Stellar, and nobody on the Stellar side pays gas but
 *  the relayer (at the event: the sponsor Worker's /cctp-relay). Measured, with hashes:
 *    1. Base Sepolia: `approve` + `depositForBurnWithHook` on TokenMessengerV2, `mintRecipient`
 *       AND `destinationCaller` = the Stellar CctpForwarder as bytes32, `hookData` = the recipient
 *       strkey in Circle's hook layout. (Both fields wrong = funds stranded forever: the skill's one
 *       rule, skills/cross-chain/cctp.md.)
 *    2. Iris sandbox: poll until the attestation is `complete`; record the latency.
 *    3. Stellar: a friendbot-funded RELAYER key invokes `mint_and_forward(message, attestation)`
 *       on the forwarder; the recipient G account (sponsored-style: friendbot + USDC trustline,
 *       standing in for an account the sponsor created) receives 7-decimal USDC.
 *    4. Verify the minted asset is Circle's testnet USDC (GBBD47IF...FLA5) and the amount is the
 *       6-decimal message amount x 10 minus the fee.
 *
 *  STATE. Keys and progress live in apps/sponsor/.env.cctp-spike.json (gitignored, testnet only):
 *  the Base Sepolia sender (funded by the owner from faucet.circle.com by hand), the Stellar
 *  recipient and relayer (generated here), and the last burn, so a run interrupted after the burn
 *  resumes at the attestation poll instead of burning again.
 *
 *  RUN:  pnpm --filter @lumenia/sponsor spike7                 # full run
 *        DRY_RUN=1 pnpm --filter @lumenia/sponsor spike7       # prep + encoding only, no burn
 *        AMOUNT=2 FINALITY=1000 pnpm --filter @lumenia/sponsor spike7   # 2 USDC, Fast finality
 *        RELAY=module ...   # the mint goes through lib/cctp-relay.ts (the /cctp-relay route's own
 *                           # code: Iris read by the module, header checks, simulate, fee cap),
 *                           # signed by the throwaway relayer instead of the sponsor
 *        RELAY=https://lumenia-sponsor.avakit.workers.dev ...   # the LIVE testnet sponsor relays it
 *  NEEDS: Base Sepolia USDC + a little Base Sepolia ETH on the sender; internet. No sponsor key.
 * ============================================================================
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Asset, BASE_FEE, Contract, Horizon, Keypair, Networks, Operation, StrKey, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { createPublicClient, createWalletClient, formatUnits, http, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CCTP_TESTNET_FORWARDER, relayCctpHandler } from "./lib/cctp-relay.js";
import { makeConfig } from "./lib/config.js";
import { signerFromSecret } from "./lib/signer.js";

/* ---------- constants (skills/cross-chain/cctp.md + docs/PRO_HACKATHON_2026.md 2.1) ---------- */
const STELLAR_DOMAIN = 27;
const BASE_SEPOLIA_DOMAIN = 6;
const BASE_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e" as const;
const BASE_TOKEN_MESSENGER_V2 = "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" as const;
const STELLAR_FORWARDER = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
const STELLAR_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const IRIS = "https://iris-api-sandbox.circle.com";
const HORIZON = "https://horizon-testnet.stellar.org";
const RPC = "https://soroban-testnet.stellar.org";
const BASE_RPC = process.env.BASE_SEPOLIA_RPC ?? "https://sepolia.base.org";
const STATE_PATH = fileURLToPath(new URL("../.env.cctp-spike.json", import.meta.url));

const AMOUNT_USDC = process.env.AMOUNT ?? "2";
/** 1000 = Fast (minutes, fee), 2000 = Standard (source-chain finality, fee 0 on the sandbox today). */
const FINALITY = Number(process.env.FINALITY ?? "2000");
const DRY_RUN = process.env.DRY_RUN === "1";
/** Unset: the script mints itself (the 2026-09-19 proof runs). "module": through lib/cctp-relay.ts. A URL: through that sponsor's /cctp-relay. */
const RELAY = process.env.RELAY ?? "";

const ERC20_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

/** TokenMessengerV2.depositForBurnWithHook (Circle EVM contract reference). */
const TOKEN_MESSENGER_ABI = [
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

interface State {
  chain: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  purpose: string;
  created: string;
  stellarRecipient?: { publicKey: string; secret: string };
  stellarRelayer?: { publicKey: string; secret: string };
  burn?: { txHash: `0x${string}`; amount: string; finality: number; at: string; minted?: string; recipient: string };
}

const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const step = (m: string) => console.log(`[${at()}] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function loadState(): State {
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as State;
}
function saveState(s: State) {
  writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
}

/* ---------- Circle's hook layout, verbatim from the skill; the fund-loss-critical bytes ---------- */
function buildForwarderHookData(forwardRecipientStrkey: string): Hex {
  const ok =
    StrKey.isValidEd25519PublicKey(forwardRecipientStrkey) ||
    StrKey.isValidContract(forwardRecipientStrkey) ||
    StrKey.isValidMed25519PublicKey(forwardRecipientStrkey);
  if (!ok) throw new Error(`invalid forward recipient: ${forwardRecipientStrkey}`);
  const recipientBytes = Buffer.from(forwardRecipientStrkey, "utf8");
  const hook = Buffer.alloc(32 + recipientBytes.length); // bytes 0-23 stay zero (magic)
  hook.writeUInt32BE(0, 24); // version 0
  hook.writeUInt32BE(recipientBytes.length, 28); // recipient length
  recipientBytes.copy(hook, 32);
  return `0x${hook.toString("hex")}`;
}
function contractToBytes32(strkey: string): Hex {
  if (!StrKey.isValidContract(strkey)) throw new Error(`not a contract strkey: ${strkey}`);
  return `0x${Buffer.from(StrKey.decodeContract(strkey)).toString("hex")}`;
}

/* ---------- Stellar helpers ---------- */
async function friendbot(pub: string) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(pub)}`);
  if (!r.ok && r.status !== 400) throw new Error(`friendbot ${r.status}`); // 400 = already funded
}
async function ensureTrustline(horizon: Horizon.Server, kp: Keypair, usdc: Asset) {
  const acc = await horizon.loadAccount(kp.publicKey());
  if (acc.balances.some((b) => "asset_code" in b && b.asset_code === "USDC" && b.asset_issuer === STELLAR_USDC_ISSUER)) return null;
  const tx = new TransactionBuilder(acc, { fee: BASE_FEE, networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  return (await horizon.submitTransaction(tx)).hash;
}
async function usdcBalance(horizon: Horizon.Server, pub: string): Promise<string> {
  const acc = await horizon.loadAccount(pub);
  const b = acc.balances.find((x) => "asset_code" in x && x.asset_code === "USDC" && x.asset_issuer === STELLAR_USDC_ISSUER);
  return b ? b.balance : "0";
}

/* ---------- Iris ---------- */
interface IrisMessage { status: string; message?: Hex; attestation?: Hex; eventNonce?: string; delayReason?: string; cctpVersion?: number }
async function pollIris(burnTx: string, maxMs: number): Promise<{ msg: IrisMessage; latencyMs: number; polls: number }> {
  const url = `${IRIS}/v2/messages/${BASE_SEPOLIA_DOMAIN}?transactionHash=${burnTx.toLowerCase()}`;
  const start = Date.now();
  let polls = 0;
  let lastStatus = "";
  for (;;) {
    polls++;
    let r: Response;
    try {
      r = await fetch(url);
    } catch (e) {
      // A dropped request is not a missing attestation. The first Standard run on 2026-09-19 died
      // here on one "fetch failed" after the burn had already landed.
      step(`Iris: request failed (${(e as Error).message}), retrying`);
      await sleep(10_000);
      continue;
    }
    if (r.status === 404) {
      if (lastStatus !== "404") step("Iris: not indexed yet (404)");
      lastStatus = "404";
    } else if (r.ok) {
      const body = (await r.json()) as { messages?: IrisMessage[] };
      const msg = body.messages?.[0];
      if (msg) {
        if (msg.status !== lastStatus) step(`Iris: status ${msg.status}${msg.delayReason ? ` (${msg.delayReason})` : ""}`);
        lastStatus = msg.status;
        if (msg.status === "complete" && msg.message && msg.attestation) return { msg, latencyMs: Date.now() - start, polls };
      }
    } else {
      step(`Iris: HTTP ${r.status}`);
    }
    if (Date.now() - start > maxMs) throw new Error(`no attestation after ${Math.round(maxMs / 1000)} s (last status ${lastStatus})`);
    await sleep(10_000);
  }
}

async function main() {
  const state = loadState();
  const horizon = new Horizon.Server(HORIZON);
  const soroban = new rpc.Server(RPC);
  const usdc = new Asset("USDC", STELLAR_USDC_ISSUER);

  /* 1. Stellar side: a recipient with a trustline (what the sponsor does for every claimer) and a
        relayer with XLM (what the sponsor Worker will be at the event). Both persisted. */
  if (!state.stellarRecipient) {
    const kp = Keypair.random();
    state.stellarRecipient = { publicKey: kp.publicKey(), secret: kp.secret() };
    saveState(state);
  }
  if (!state.stellarRelayer) {
    const kp = Keypair.random();
    state.stellarRelayer = { publicKey: kp.publicKey(), secret: kp.secret() };
    saveState(state);
  }
  const recipient = Keypair.fromSecret(state.stellarRecipient.secret);
  const relayer = Keypair.fromSecret(state.stellarRelayer.secret);
  await friendbot(recipient.publicKey());
  await friendbot(relayer.publicKey());
  const trustHash = await ensureTrustline(horizon, recipient, usdc);
  step(`Stellar recipient ${recipient.publicKey()} (trustline ${trustHash ? `opened: ${trustHash}` : "already open"})`);
  step(`Stellar relayer   ${relayer.publicKey()} (friendbot-funded; the sponsor at the event)`);
  const balanceBefore = await usdcBalance(horizon, recipient.publicKey());
  step(`recipient USDC before: ${balanceBefore}`);

  /* 2. Encoding, printed so a human can eyeball the fund-loss-critical bytes before any burn. */
  const forwarder32 = contractToBytes32(STELLAR_FORWARDER);
  const hookData = buildForwarderHookData(recipient.publicKey());
  step(`mintRecipient = destinationCaller = forwarder bytes32 ${forwarder32}`);
  step(`hookData (${(hookData.length - 2) / 2} bytes) ${hookData}`);

  /* 3. EVM side. */
  const evm = privateKeyToAccount(state.privateKey);
  const pub = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC) });
  const wallet = createWalletClient({ account: evm, chain: baseSepolia, transport: http(BASE_RPC) });
  const [eth, usdcBal] = await Promise.all([
    pub.getBalance({ address: evm.address }),
    pub.readContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "balanceOf", args: [evm.address] }),
  ]);
  step(`Base Sepolia sender ${evm.address}: ETH ${formatUnits(eth, 18)}, USDC ${formatUnits(usdcBal, 6)}`);

  const fees = (await (await fetch(`${IRIS}/v2/burn/USDC/fees/${BASE_SEPOLIA_DOMAIN}/${STELLAR_DOMAIN}`)).json()) as { finalityThreshold: number; minimumFee: number }[];
  const tier = fees.find((f) => f.finalityThreshold === FINALITY);
  if (!tier) throw new Error(`no fee tier for finality ${FINALITY}: ${JSON.stringify(fees)}`);
  const amount = parseUnits(AMOUNT_USDC, 6);
  // minimumFee is quoted in basis points of the amount on the fee endpoint (1.3 = 0.013%); take a
  // margin so a Fast burn is never downgraded for insufficient fee. Standard is 0 on the sandbox.
  const maxFee = tier.minimumFee === 0 ? 0n : (amount * BigInt(Math.ceil(tier.minimumFee * 100)) + 999_999n) / 1_000_000n + 1n;
  step(`fee schedule ${JSON.stringify(fees)} -> finality ${FINALITY}, maxFee ${formatUnits(maxFee, 6)} USDC on ${AMOUNT_USDC}`);

  let burn = state.burn;
  if (burn && burn.minted) {
    step(`last burn ${burn.txHash} was already minted on Stellar (${burn.minted}); start a fresh run by deleting "burn" from the state file`);
    burn = undefined;
  }
  if (!burn) {
    if (DRY_RUN) {
      step("DRY_RUN=1: stopping before the burn. Everything above is ready.");
      return;
    }
    if (usdcBal < amount) throw new Error(`sender holds ${formatUnits(usdcBal, 6)} USDC, needs ${AMOUNT_USDC} (faucet.circle.com, Base Sepolia)`);
    if (eth === 0n) throw new Error("sender holds no Base Sepolia ETH for gas: send ~0.002 ETH to the sender address first");

    const allowance = await pub.readContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "allowance", args: [evm.address, BASE_TOKEN_MESSENGER_V2] });
    if (allowance < amount) {
      const h = await wallet.writeContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "approve", args: [BASE_TOKEN_MESSENGER_V2, amount] });
      step(`approve sent ${h}`);
      const rc = await pub.waitForTransactionReceipt({ hash: h });
      step(`approve ${rc.status} in block ${rc.blockNumber}`);
      if (rc.status !== "success") throw new Error("approve reverted");
    } else {
      step("allowance already sufficient");
    }
    // The public RPC is load-balanced: a receipt from one node does not mean the next eth_call
    // hits a node that has that block. Read the allowance back until it is there (first run of
    // 2026-09-19 simulated one block early and got "transfer amount exceeds allowance").
    for (let i = 0; i < 30; i++) {
      const a = await pub.readContract({ address: BASE_USDC, abi: ERC20_ABI, functionName: "allowance", args: [evm.address, BASE_TOKEN_MESSENGER_V2] });
      if (a >= amount) break;
      if (i === 29) throw new Error("allowance never became visible on the RPC");
      await sleep(2000);
    }

    // Simulate first: a revert here costs nothing and names the reason.
    const { request } = await pub.simulateContract({
      account: evm,
      address: BASE_TOKEN_MESSENGER_V2,
      abi: TOKEN_MESSENGER_ABI,
      functionName: "depositForBurnWithHook",
      args: [amount, STELLAR_DOMAIN, forwarder32, BASE_USDC, forwarder32, maxFee, FINALITY, hookData],
    });
    const burnHash = await wallet.writeContract(request);
    burn = { txHash: burnHash, amount: AMOUNT_USDC, finality: FINALITY, at: new Date().toISOString(), recipient: recipient.publicKey() };
    state.burn = burn;
    saveState(state);
    step(`depositForBurnWithHook sent ${burnHash}`);
    const rc = await pub.waitForTransactionReceipt({ hash: burnHash });
    step(`burn ${rc.status} in block ${rc.blockNumber} (gas used ${rc.gasUsed})`);
    if (rc.status !== "success") throw new Error("burn reverted");
  } else {
    step(`resuming burn ${burn.txHash} from ${burn.at} (${burn.amount} USDC, finality ${burn.finality}, recipient ${burn.recipient})`);
  }

  /* 4-5. Attestation and the Stellar mint. With RELAY set, the product path does both. */
  const burnAt = Date.parse(burn.at);
  let mintHash: string;
  let latencyMs: number;
  if (RELAY) {
    const pollStart = Date.now();
    let result: { status: string; hash?: string; detail?: string; nonce?: string } | null = null;
    for (let i = 0; i < 1200; i++) {
      if (RELAY === "module") {
        const config = makeConfig({ network: "testnet", sponsorSecret: relayer.secret(), usdcIssuer: STELLAR_USDC_ISSUER });
        result = await relayCctpHandler(config, signerFromSecret(relayer.secret()), { burnTxHash: burn.txHash }, { forwarder: CCTP_TESTNET_FORWARDER });
      } else {
        const r = await fetch(`${RELAY.replace(/\/$/, "")}/cctp-relay`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://getlumenia.com" },
          body: JSON.stringify({ burnTxHash: burn.txHash }),
        });
        const body = (await r.json().catch(() => ({}))) as { status?: string; hash?: string; detail?: string; error?: string };
        if (r.status !== 200 && r.status !== 202) throw new Error(`sponsor /cctp-relay ${r.status}: ${body.error ?? JSON.stringify(body)}`);
        result = { status: body.status ?? "?", hash: body.hash, detail: body.detail };
      }
      if (result.status === "minted") break;
      if (i === 0 || i % 10 === 0) step(`relay (${RELAY === "module" ? "lib/cctp-relay.ts" : RELAY}): ${result.detail ?? result.status}`);
      await sleep(3000);
    }
    if (!result || result.status !== "minted" || !result.hash) throw new Error("the relay never minted inside the wait");
    mintHash = result.hash;
    latencyMs = Date.now() - pollStart;
    step(`minted through ${RELAY === "module" ? "lib/cctp-relay.ts" : `${RELAY}/cctp-relay`}: ${mintHash} (nonce ${result.nonce ?? "?"})`);
  } else {
    const polled = await pollIris(burn.txHash, 60 * 60_000);
    const msg = polled.msg;
    latencyMs = polled.latencyMs;
    step(`attestation complete: ${polled.polls} polls, ${(latencyMs / 1000).toFixed(0)} s since polling began, ${((Date.now() - burnAt) / 1000).toFixed(0)} s since the burn`);
    const message = Buffer.from(msg.message!.slice(2), "hex");
    const attestation = Buffer.from(msg.attestation!.slice(2), "hex");
    step(`message ${message.length} bytes, attestation ${attestation.length} bytes, nonce ${msg.eventNonce ?? "?"}`);

    /* Stellar mint + forward, paid by the relayer. */
    const relayerAcc = await soroban.getAccount(relayer.publicKey());
    const tx = new TransactionBuilder(relayerAcc, { fee: "2000000", networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(STELLAR_FORWARDER).call("mint_and_forward", xdr.ScVal.scvBytes(message), xdr.ScVal.scvBytes(attestation)))
      .setTimeout(120)
      .build();
    const sim = await soroban.simulateTransaction(tx);
    if (rpc.Api.isSimulationError(sim)) throw new Error(`mint_and_forward simulation failed: ${sim.error}`);
    const prepared = rpc.assembleTransaction(tx, sim).build();
    step(`mint_and_forward simulated: resource fee ${sim.minResourceFee} stroops, ${sim.result?.auth?.length ?? 0} auth entries`);
    prepared.sign(relayer);
    const sent = await soroban.sendTransaction(prepared);
    if (sent.status !== "PENDING") throw new Error(`sendTransaction ${sent.status}: ${sent.errorResult?.toXDR("base64") ?? ""}`);
    step(`mint_and_forward submitted ${sent.hash}`);
    let got = await soroban.getTransaction(sent.hash);
    for (let i = 0; i < 40 && got.status === "NOT_FOUND"; i++) {
      await sleep(1500);
      got = await soroban.getTransaction(sent.hash);
    }
    if (got.status !== "SUCCESS") throw new Error(`mint_and_forward ${got.status}`);
    step(`mint_and_forward SUCCESS in ledger ${got.ledger}`);
    mintHash = sent.hash;
  }
  state.burn = { ...burn, minted: mintHash };
  saveState(state);

  /* 6. Verify. */
  const balanceAfter = await usdcBalance(horizon, recipient.publicKey());
  const delta = (Number(balanceAfter) - Number(balanceBefore)).toFixed(7);
  step(`recipient USDC after: ${balanceAfter} (delta ${delta}; asset USDC:${STELLAR_USDC_ISSUER.slice(0, 8)}...)`);

  console.log("\nRESULT");
  console.log(`  direction          Base Sepolia (domain 6) -> Stellar testnet (domain 27) via CctpForwarder`);
  console.log(`  amount             ${burn.amount} USDC, finality ${burn.finality}, maxFee ${formatUnits(maxFee, 6)}`);
  console.log(`  sender (EVM)       ${evm.address}`);
  console.log(`  burn tx            ${burn.txHash}`);
  console.log(`  attestation        ${(latencyMs / 1000).toFixed(0)} s of polling, ${((Date.now() - burnAt) / 1000).toFixed(0)} s burn-to-mint total`);
  console.log(`  relayed by         ${RELAY ? (RELAY === "module" ? `lib/cctp-relay.ts, signed by ${relayer.publicKey()}` : `${RELAY}/cctp-relay (the sponsor)`) : relayer.publicKey()}`);
  console.log(`  mint_and_forward   ${mintHash}`);
  console.log(`  recipient          ${recipient.publicKey()}`);
  console.log(`  received           ${delta} USDC (Circle testnet issuer)`);
  console.log(`  explorer           https://stellar.expert/explorer/testnet/tx/${mintHash}`);
  console.log(`  basescan           https://sepolia.basescan.org/tx/${burn.txHash}`);
  console.log(`\nCCTP INBOUND SPIKE PASS (${at()})`);
}

main().catch((e) => {
  console.error(`\nCCTP INBOUND SPIKE FAIL at ${at()}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
