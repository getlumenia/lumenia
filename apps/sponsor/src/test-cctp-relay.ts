/**
 * ============================================================================
 *  TEST: the CCTP inbound relay (/cctp-relay), offline
 * ============================================================================
 *
 *  The fixture is REAL: Circle's Iris answer for the Fast-finality burn proven on 2026-09-19
 *  (burn 0xddf8f16a...08fc on Base Sepolia, minted on Stellar testnet as 617908c7...1261). So the
 *  header offsets below are checked against bytes Circle actually produced, not a hand-made guess.
 *
 *  Nothing here reaches a network. The route checks run through `worker.fetch` with a throwaway
 *  sponsor key and no KV (the rate limiter and caps fall back to memory), and Circle is a fake
 *  `fetch`. The [submit] section drives the handler PAST the attestation with the real fixture, a
 *  fake Soroban RPC (`opts.relay`) and a fake caps store: the fee charge before the signature, the
 *  busy answer, and the one 202 body for a mint that was submitted but not yet seen to land.
 *
 *  RUN: pnpm --filter @lumenia/sponsor test:cctp   (no network, no live keys)
 * ============================================================================
 */
import { Account, Keypair, SorobanDataBuilder, StrKey, rpc, xdr, type FeeBumpTransaction, type Transaction } from "@stellar/stellar-sdk";
import { FEE_BUDGET_REFUSAL, isPublicRefusal } from "./lib/caps.js";
import type { ChannelManager } from "./lib/channels.js";
import { isRelayBusy, type RelayRpc } from "./lib/soroban-relay.js";
import {
  CCTP_FEE_CAP,
  CCTP_FORWARDERS,
  CCTP_METHOD,
  CCTP_SOURCE_DOMAINS,
  CCTP_STELLAR_DOMAIN,
  CCTP_TESTNET_FORWARDER,
  checkCctpMessage,
  fetchAttestation,
  parseCctpHeader,
  relayCctpHandler,
} from "./lib/cctp-relay.js";
import { makeConfig } from "./lib/config.js";
import worker from "./worker.js";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}
async function throws(name: string, fn: () => unknown, mustMention?: string): Promise<void> {
  try {
    await fn();
    ok(name, false, "it did NOT throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(name, mustMention ? msg.toLowerCase().includes(mustMention.toLowerCase()) : true, msg.slice(0, 80));
  }
}

const MESSAGE_HEX =
  "0x00000001000000060000001b8a4053b341a0a42349a16d238a3aea7950c34bd63cbad926c981275358d0b3e80000000000" +
  "000000000000008fe6b999dc680ccfdd5bf7eb0974218be2542daada6f9ee0786c812344d82817ef19b648b4af120f8bd10b" +
  "f658e6b99eacff24b83de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e000003e8000003e800" +
  "000001000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e3de86ac50b47eaf2840fe23e481795" +
  "51660fd1072fba6f445d4a6bd7af4ab93e00000000000000000000000000000000000000000000000000000000001e848000" +
  "000000000000000000000018762f1cb5871147ab83598956f695fa5dc4d03d00000000000000000000000000000000000000" +
  "0000000000000000000000010500000000000000000000000000000000000000000000000000000000000001040000000000" +
  "00000000000000000000000000000000000000000000000048e5f10000000000000000000000000000000000000000000000" +
  "000000000000000038474355364352375437434e4946424652414b414c4c4734364659484d434e52524757354935354e4535" +
  "4d5936524448584c55585858423232";
const ATTESTATION_HEX =
  "0x8d2ea3c23b981dbaee84aae4968b3d9475a6c23e6c07e901ad362a20662066f47fd7f2af279b1337c735e27f53b49fbb7e" +
  "e341e015cd36b20585d929abfa2a611be88767db0f93b2e6e0a9fe55d2d28e99aebd2f44b2d3525f0f389973993661ca20b1" +
  "aa8bd45e7bb21d8a6b742a79bdb1e0d427c611de16c1910e682ad962a8661b";
const BURN = "0xddf8f16a31f3893577460ec5041204db66b8f6f009bbafc1614b49e7be6208fc";

const bytes = (h: string) => new Uint8Array(Buffer.from(h.replace(/^0x/, ""), "hex"));
const MSG = bytes(MESSAGE_HEX);
const ATT = bytes(ATTESTATION_HEX);

function irisFake(answer: { status: number; body?: unknown }, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(typeof input === "string" ? input : input.toString());
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
}

async function main(): Promise<void> {
  console.log("[golden] the relay can only ever call one contract and one method");
  ok("the only forwarder is Circle's testnet CctpForwarder", CCTP_FORWARDERS.size === 1 && CCTP_FORWARDERS.has("CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ"));
  ok("the only method is mint_and_forward", CCTP_METHOD === "mint_and_forward");
  ok("the only destination is Stellar (27)", CCTP_STELLAR_DOMAIN === 27);
  ok("the only source is Base (6)", CCTP_SOURCE_DOMAINS.size === 1 && CCTP_SOURCE_DOMAINS.has(6));
  ok("the fee ceiling is 2 XLM", CCTP_FEE_CAP === 20_000_000);

  console.log("\n[header] offsets checked against Circle's real message");
  const h = parseCctpHeader(MSG);
  ok("the real message is 464 bytes and the attestation 130", MSG.length === 464 && ATT.length === 130);
  ok("version 1", h.version === 1);
  ok("source domain 6 (Base Sepolia)", h.sourceDomain === 6);
  ok("destination domain 27 (Stellar)", h.destinationDomain === 27);
  ok("the nonce Circle reported", h.nonce.startsWith("8a4053b341a0a423"));
  ok("destination caller is the forwarder's 32 bytes", h.destinationCaller === Buffer.from(StrKey.decodeContract(CCTP_TESTNET_FORWARDER)).toString("hex"));
  ok("Fast finality (1000) requested and executed", h.minFinalityThreshold === 1000 && h.finalityThresholdExecuted === 1000);

  console.log("\n[check] what the sponsor refuses to pay for, before any simulation");
  ok("the real message passes", checkCctpMessage(MSG, ATT, CCTP_TESTNET_FORWARDER).destinationDomain === 27);
  const edit = (o: number, v: number) => {
    const m = MSG.slice();
    m[o] = v;
    return m;
  };
  await throws("a message for another chain is refused", () => checkCctpMessage(edit(11, 3), ATT, CCTP_TESTNET_FORWARDER), "not for stellar");
  await throws("a burn from a chain off the allowlist is refused", () => checkCctpMessage(edit(7, 0), ATT, CCTP_TESTNET_FORWARDER), "not allowed");
  await throws("a message whose caller is not the forwarder is refused", () => checkCctpMessage(edit(120, MSG[120] ^ 0xff), ATT, CCTP_TESTNET_FORWARDER), "forwarder");
  await throws("a truncated message is refused", () => checkCctpMessage(MSG.slice(0, 100), ATT, CCTP_TESTNET_FORWARDER), "too short");
  await throws("an oversized message is refused", () => checkCctpMessage(new Uint8Array(4096), ATT, CCTP_TESTNET_FORWARDER), "too long");
  await throws("an attestation that is not whole signatures is refused", () => checkCctpMessage(MSG, ATT.slice(0, 100), CCTP_TESTNET_FORWARDER), "length");
  await throws("an empty attestation is refused", () => checkCctpMessage(MSG, new Uint8Array(0), CCTP_TESTNET_FORWARDER), "length");

  console.log("\n[iris] one read of Circle's attestation service, never a wait");
  const seen: string[] = [];
  const done = await fetchAttestation("https://iris.test/", 6, BURN.toUpperCase().replace("0X", "0x"), irisFake({ status: 200, body: { messages: [{ status: "complete", message: MESSAGE_HEX, attestation: ATTESTATION_HEX }] } }, seen));
  ok("asks /v2/messages/6 with the lower-cased burn hash", seen[0] === `https://iris.test/v2/messages/6?transactionHash=${BURN}`);
  ok("a complete answer returns the exact bytes", done.status === "complete" && Buffer.from(done.message).equals(Buffer.from(MSG)) && Buffer.from(done.attestation).equals(Buffer.from(ATT)));
  const notYet = await fetchAttestation("https://iris.test", 6, BURN, irisFake({ status: 404 }));
  ok("404 is pending (not indexed yet), not an error", notYet.status === "pending");
  const conf = await fetchAttestation("https://iris.test", 6, BURN, irisFake({ status: 200, body: { messages: [{ status: "pending_confirmations", message: "0x", attestation: "PENDING" }] } }));
  ok("pending_confirmations is pending", conf.status === "pending" && conf.detail.includes("pending_confirmations"));
  const empty = await fetchAttestation("https://iris.test", 6, BURN, irisFake({ status: 200, body: { messages: [] } }));
  ok("no message yet is pending", empty.status === "pending");
  await throws("a 500 from Circle is an error, not a pending", () => fetchAttestation("https://iris.test", 6, BURN, irisFake({ status: 500 })), "500");

  console.log("\n[handler] refusals that never reach the network");
  const testnet = makeConfig({ network: "testnet", sponsorSecret: Keypair.random().secret(), usdcIssuer: Keypair.random().publicKey() });
  const mainnet = makeConfig({ network: "mainnet", sponsorSecret: Keypair.random().secret(), usdcIssuer: Keypair.random().publicKey() });
  const signer = { publicKey: () => Keypair.random().publicKey(), sign: () => undefined } as never;
  let irisCalls = 0;
  const counting = (async () => {
    irisCalls++;
    return new Response("", { status: 404 });
  }) as typeof fetch;
  await throws("mainnet is refused", () => relayCctpHandler(mainnet, signer, { burnTxHash: BURN }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: counting }), "testnet-only");
  await throws("an unknown forwarder is refused", () => relayCctpHandler(testnet, signer, { burnTxHash: BURN }, { forwarder: "C" + "A".repeat(55), fetchImpl: counting }), "not configured");
  await throws("no forwarder is refused", () => relayCctpHandler(testnet, signer, { burnTxHash: BURN }, { fetchImpl: counting }), "not configured");
  await throws("a malformed burn hash is refused", () => relayCctpHandler(testnet, signer, { burnTxHash: "0x1234" }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: counting }), "burnTxHash");
  await throws("a source domain off the allowlist is refused", () => relayCctpHandler(testnet, signer, { burnTxHash: BURN, sourceDomain: 0 }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: counting }), "not allowed");
  ok("none of those refusals asked Circle anything", irisCalls === 0);
  const pend = await relayCctpHandler(testnet, signer, { burnTxHash: BURN }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: counting });
  ok("a burn Circle has not attested yet is pending, with no Stellar call", pend.status === "pending" && irisCalls === 1);
  const forged = irisFake({ status: 200, body: { messages: [{ status: "complete", message: "0x" + Buffer.from(edit(11, 3)).toString("hex"), attestation: ATTESTATION_HEX }] } });
  await throws("an attested message for another chain is refused before simulation", () => relayCctpHandler(testnet, signer, { burnTxHash: BURN }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: forged }), "not for stellar");

  console.log("\n[route] POST /cctp-relay through worker.fetch");
  const ENV = {
    STELLAR_NETWORK: "testnet",
    SPONSOR_SECRET: Keypair.random().secret(),
    USDC_ISSUER: Keypair.random().publicKey(),
    ALLOWED_ORIGIN: "https://getlumenia.com",
  };
  const call = async (body: unknown) => {
    const res = await worker.fetch(new Request("https://sponsor.test/cctp-relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), ENV);
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  delete process.env.CCTP_FORWARDER;
  const off = await call({ burnTxHash: BURN });
  ok("without CCTP_FORWARDER the route is 503, not a guess", off.status === 503);
  process.env.CCTP_FORWARDER = CCTP_TESTNET_FORWARDER;
  process.env.CCTP_IRIS_URL = "https://iris.test";
  const bad = await call({ burnTxHash: "nope" });
  ok("a body without a burn hash is 400", bad.status === 400);
  const realFetch = globalThis.fetch;
  globalThis.fetch = irisFake({ status: 404 });
  const waiting = await call({ burnTxHash: BURN }).finally(() => {
    globalThis.fetch = realFetch;
  });
  ok("a burn Circle has not attested yet answers 202 pending", waiting.status === 202 && waiting.json.status === "pending");

  console.log("\n[submit] past the attestation: the fee is charged before the signature, and a submitted mint is one 202 body");
  {
    type Send = "PENDING" | "TRY_AGAIN_LATER" | "THROW_UNANSWERED";
    type Get = "SUCCESS" | "NOT_FOUND" | "THROW";
    const complete = irisFake({ status: 200, body: { messages: [{ status: "complete", message: MESSAGE_HEX, attestation: ATTESTATION_HEX }] } });
    /** Every address the relay asked the RPC to load, so the account/signer split can be checked. */
    const accountsAsked: string[] = [];
    const fakeRpc = (send: Send, get: Get[]) => (_url: string): RelayRpc => {
      let reads = 0;
      return {
        async getAccount(address: string) {
          accountsAsked.push(address);
          return new Account(address, "1");
        },
        async simulateTransaction() {
          return {
            _parsed: true,
            latestLedger: 1,
            events: [],
            minResourceFee: "400000",
            transactionData: new SorobanDataBuilder().setResourceFee(400_000),
            result: { auth: [], retval: xdr.ScVal.scvVoid() },
          } as unknown as rpc.Api.SimulateTransactionResponse;
        },
        async sendTransaction(tx: Transaction | FeeBumpTransaction) {
          if (send === "THROW_UNANSWERED") throw new TypeError("fetch failed: socket hang up");
          return { status: send, hash: tx.hash().toString("hex"), latestLedger: 1, latestLedgerCloseTime: 0 } as unknown as rpc.Api.SendTransactionResponse;
        },
        async getTransaction(hash: string) {
          const st = get[Math.min(reads++, get.length - 1)]!;
          if (st === "THROW") throw new Error("the rpc went away");
          return { status: rpc.Api.GetTransactionStatus[st], txHash: hash, latestLedger: 1, latestLedgerCloseTime: 0, oldestLedger: 1, oldestLedgerCloseTime: 0 } as unknown as rpc.Api.GetTransactionResponse;
        },
      };
    };
    // The caps store: counts the fee charges (positive INCRBY on the fees key) and their give-backs.
    const store = new Map<string, bigint>();
    const feeMoves: bigint[] = [];
    const realFetch2 = globalThis.fetch;
    process.env.KV_REST_API_URL = "https://fake-kv.test";
    process.env.KV_REST_API_TOKEN = "t";
    globalThis.fetch = (async (_url: string | URL, init?: { body?: string }) => {
      const cmds = JSON.parse(String(init?.body ?? "[]")) as string[][];
      const results = cmds.map(([op, key, arg]) => {
        if (op === "EXPIRE") return { result: 1 };
        const next = (store.get(key!) ?? 0n) + BigInt(arg!);
        store.set(key!, next);
        if (key!.includes(":fees:") && !key!.endsWith(":gross")) feeMoves.push(BigInt(arg!)); // the net key only
        return { result: next.toString() };
      });
      return { ok: true, status: 200, json: async () => results } as unknown as Response;
    }) as typeof fetch;
    const sponsorKey = Keypair.random();
    const cfg = makeConfig({ network: "testnet", sponsorSecret: sponsorKey.secret(), usdcIssuer: Keypair.random().publicKey() });
    const recording = () => {
      const signed: string[] = [];
      return {
        signed,
        signer: { publicKey: () => sponsorKey.publicKey(), sign: (tx: Transaction | FeeBumpTransaction) => void (signed.push(tx.fee), tx.sign(sponsorKey)) },
      };
    };
    const mint = async (send: Send, get: Get[], channels?: ChannelManager) => {
      store.clear();
      feeMoves.length = 0;
      const rec = recording();
      try {
        const out = await relayCctpHandler(cfg, rec.signer, { burnTxHash: BURN }, {
          forwarder: CCTP_TESTNET_FORWARDER,
          fetchImpl: complete,
          channels,
          relay: { rpc: fakeRpc(send, get), pollMs: 1, maxPolls: 2 },
        });
        return { out, err: null as unknown, signed: rec.signed };
      } catch (err) {
        return { out: null, err, signed: rec.signed };
      }
    };
    const landed = await mint("PENDING", ["SUCCESS"]);
    ok("a mint that lands answers {status:'minted', confirmed:true}", landed.out?.status === "minted" && "confirmed" in landed.out && landed.out.confirmed === true, String((landed.err as Error | null)?.message ?? ""));
    ok("its fee was charged once, before the one signature", feeMoves.filter((m) => m > 0n).length === 1 && landed.signed.length === 1);
    const late = await mint("PENDING", ["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
    ok("NOT_FOUND after the window: {status:'minted', confirmed:false}, never 'failed'", late.out?.status === "minted" && "confirmed" in late.out && late.out.confirmed === false);
    ok("and the whole bid stays counted (undecided)", feeMoves.every((m) => m > 0n));
    const gone = await mint("PENDING", ["NOT_FOUND", "THROW"]);
    ok(
      "an RPC that dies mid-poll gives the SAME body {status:'minted', confirmed:false}, with the hash (it used to read as Circle still attesting)",
      gone.out?.status === "minted" && "hash" in gone.out && /^[0-9a-f]{64}$/.test(gone.out.hash) && gone.out.confirmed === false,
      String((gone.err as Error | null)?.message ?? ""),
    );
    const unanswered = await mint("THROW_UNANSWERED", ["SUCCESS"]);
    ok("a send that went unanswered gives that body too", unanswered.out?.status === "minted" && "confirmed" in unanswered.out && unanswered.out.confirmed === false);
    const busy = await mint("TRY_AGAIN_LATER", ["SUCCESS"]);
    ok("TRY_AGAIN_LATER raises 'busy' (503), nothing queued", isRelayBusy(busy.err), String((busy.err as Error | null)?.message));
    ok("and the bid comes back whole", feeMoves.reduce((a, b) => a + b, 0n) === 0n, feeMoves.join(","));
    // ORDER: with the day's budget spent the refusal comes before ANY sponsor signature.
    store.clear();
    feeMoves.length = 0;
    const day = new Date().toISOString().slice(0, 10);
    const rec = recording();
    let refusal: unknown = null;
    try {
      store.set(`caps:testnet:fees:${day}`, 20_000_000_000n);
      await relayCctpHandler(cfg, rec.signer, { burnTxHash: BURN }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: complete, relay: { rpc: fakeRpc("PENDING", ["SUCCESS"]), pollMs: 1, maxPolls: 2 } });
    } catch (e) {
      refusal = e;
    }
    ok("ORDER: a spent fee budget refuses the mint with the public sentence", isPublicRefusal(refusal) && (refusal as Error).message === FEE_BUDGET_REFUSAL, String((refusal as Error | null)?.message));
    ok("ORDER: and the sponsor signed nothing", rec.signed.length === 0);
    // The channel path keeps its lease for an undecided mint, and frees it for a decided one.
    const pool = () => {
      const channel = Keypair.random();
      const state = { released: 0 };
      const manager = { enabled: true, lease: async () => ({ keypair: channel, publicKey: channel.publicKey(), release: async () => void state.released++ }) } as unknown as ChannelManager;
      return { manager, state };
    };
    const kept = pool();
    await mint("THROW_UNANSWERED", ["SUCCESS"], kept.manager);
    ok("an undecided mint keeps its channel lease (it may still land on that sequence)", kept.state.released === 0);
    const freed = pool();
    const viaChannel = await mint("PENDING", ["SUCCESS"], freed.manager);
    ok("a decided mint frees it", freed.state.released === 1);
    ok("and its fee-bump bids 2 x 1,000,000 + 400,000 (the inner's inclusion fee as the base)", viaChannel.signed[0] === "2400000", viaChannel.signed.join(","));
    {
      /* A refused simulation carries the HostError's first line only (lib/soroban-relay.ts,
         simErrorHead): the event log after it replays the call's arguments and the transfer it
         reached, the recipient's full address and the amount among them, and on mainnet the reason
         is the error log's line. */
      const recipientG = Keypair.random().publicKey();
      const refusing = (url: string): RelayRpc => ({
        ...fakeRpc("PENDING", ["SUCCESS"])(url),
        async simulateTransaction() {
          return {
            _parsed: true,
            latestLedger: 1,
            events: [],
            error:
              "HostError: Error(Contract, #4)\n\nEvent log (newest first):\n" +
              `   0: [Diagnostic Event] topics:[fn_call, ${CCTP_TESTNET_FORWARDER}, mint_and_forward], data:[Bytes(${MESSAGE_HEX.slice(2, 66)}), Bytes(01)]\n` +
              `   1: [Diagnostic Event] topics:[transfer, ${recipientG}], data:7654321`,
          } as unknown as rpc.Api.SimulateTransactionResponse;
        },
      });
      store.clear();
      feeMoves.length = 0;
      const rec = recording();
      let refused = "";
      try {
        await relayCctpHandler(cfg, rec.signer, { burnTxHash: BURN }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: complete, relay: { rpc: refusing, pollMs: 1, maxPolls: 2 } });
      } catch (e) {
        refused = (e as Error).message;
      }
      ok("a mint the simulation refuses is refused with the HostError's first line", /simulation failed .*HostError: Error\(Contract, #4\)$/.test(refused), refused);
      ok(
        "one line: no event log, no full address, no amount, no message bytes",
        !/[\r\n]/.test(refused) && !refused.includes("Event log") && !refused.includes(recipientG) && !/\b[GC][A-Z2-7]{55}\b/.test(refused) && !refused.includes("7654321") && !refused.includes(MESSAGE_HEX.slice(2, 66)),
        refused,
      );
      ok("and nothing was charged or signed", feeMoves.length === 0 && rec.signed.length === 0);
    }
    {
      /* After the KMS cutover the account and the signer are two addresses (D3 item h). The mint must
         be built on the ACCOUNT (its sequence, its fee) and only signed by the signer. */
      const ACCOUNT = Keypair.random().publicKey();
      const split = makeConfig({ network: "testnet", sponsorSecret: sponsorKey.secret(), sponsorAccountId: ACCOUNT, usdcIssuer: cfg.usdc.getIssuer()! });
      const capture: Array<Transaction | FeeBumpTransaction> = [];
      const splitSigner = { publicKey: () => sponsorKey.publicKey(), sign: (tx: Transaction | FeeBumpTransaction) => void (capture.push(tx), tx.sign(sponsorKey)) };
      store.clear();
      accountsAsked.length = 0;
      await relayCctpHandler(split, splitSigner, { burnTxHash: BURN }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: complete, relay: { rpc: fakeRpc("PENDING", ["SUCCESS"]), pollMs: 1, maxPolls: 2 } });
      const signedTx = capture[0] as Transaction | undefined;
      ok("account != signer, sponsor path: the mint is loaded and sourced on the ACCOUNT, never the signer", accountsAsked[0] === ACCOUNT && signedTx?.source === ACCOUNT, `${accountsAsked.join(",")} / ${signedTx?.source}`);
      capture.length = 0;
      accountsAsked.length = 0;
      const lanes = pool();
      await relayCctpHandler(split, splitSigner, { burnTxHash: BURN }, { forwarder: CCTP_TESTNET_FORWARDER, fetchImpl: complete, channels: lanes.manager, relay: { rpc: fakeRpc("PENDING", ["SUCCESS"]), pollMs: 1, maxPolls: 2 } });
      const bump = capture[0] as FeeBumpTransaction | undefined;
      ok("account != signer, channel path: the fee-bump's fee source is the ACCOUNT", !!bump && "feeSource" in bump && bump.feeSource === ACCOUNT, String(bump && "feeSource" in bump ? bump.feeSource : "no fee-bump"));
    }
    {
      /* The Worker's OWN answer (D3 item g) through worker.fetch: a submitted mint not yet seen to land
         is 202 {status:'minted', confirmed:false}, a landed one 200. The Worker builds its own
         rpc.Server, so the client's prototype is stubbed; Circle is the only thing asked over fetch. */
      delete process.env.KV_REST_API_URL;
      delete process.env.KV_REST_API_TOKEN;
      globalThis.fetch = complete;
      process.env.CCTP_FORWARDER = CCTP_TESTNET_FORWARDER;
      process.env.CCTP_IRIS_URL = "https://iris.test";
      const proto = rpc.Server.prototype as unknown as Record<string, unknown>;
      const methods = ["getAccount", "simulateTransaction", "sendTransaction", "getTransaction"];
      const saved = Object.fromEntries(methods.map((k) => [k, proto[k]]));
      const useRpc = (send: Send, get: Get[]) => {
        const f = fakeRpc(send, get)("x") as unknown as Record<string, unknown>;
        for (const k of methods) proto[k] = f[k];
      };
      const relayOnce = async () => {
        const res = await worker.fetch(
          new Request("https://sponsor.test/cctp-relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ burnTxHash: BURN }) }),
          ENV,
        );
        return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
      };
      try {
        useRpc("THROW_UNANSWERED", ["SUCCESS"]);
        const undecided = await relayOnce();
        ok("worker.fetch: a mint whose send went unanswered answers 202 {status:'minted', confirmed:false}", undecided.status === 202 && undecided.body.status === "minted" && undecided.body.confirmed === false, `${undecided.status} ${JSON.stringify(undecided.body)}`);
        useRpc("PENDING", ["SUCCESS"]);
        const landed = await relayOnce();
        ok("worker.fetch: a mint that lands answers 200 {status:'minted', confirmed:true}", landed.status === 200 && landed.body.confirmed === true, `${landed.status} ${JSON.stringify(landed.body)}`);
        useRpc("TRY_AGAIN_LATER", ["SUCCESS"]);
        const busy = await relayOnce();
        ok("worker.fetch: a busy RPC answers 503 with the busy sentence", busy.status === 503 && /network is busy/.test(String(busy.body.error)), `${busy.status} ${JSON.stringify(busy.body)}`);
      } finally {
        for (const k of methods) proto[k] = saved[k];
      }
    }
    globalThis.fetch = realFetch2;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
  }

  console.log(`\n${failed === 0 ? "✅" : "❌"} CCTP RELAY ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
