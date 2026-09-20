/**
 * ============================================================================
 *  TEST: the CCTP inbound relay (/cctp-relay), offline
 * ============================================================================
 *
 *  The fixture is REAL: Circle's Iris answer for the Fast-finality burn proven on 2026-09-19
 *  (burn 0xddf8f16a...08fc on Base Sepolia, minted on Stellar testnet as 617908c7...1261). So the
 *  header offsets below are checked against bytes Circle actually produced, not a hand-made guess.
 *
 *  Nothing here signs, simulates or submits. The route checks run through `worker.fetch` with a
 *  throwaway sponsor key and no KV (the rate limiter and caps fall back to memory), and Circle is a
 *  fake `fetch`.
 *
 *  RUN: pnpm --filter @lumenia/sponsor test:cctp   (no network, no live keys)
 * ============================================================================
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";
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

  console.log(`\n${failed === 0 ? "✅" : "❌"} CCTP RELAY ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
