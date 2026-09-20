/**
 * Offline checks for the browser half of CCTP inbound (lib/cctp.ts). The golden values are the
 * bytes that actually minted on 2026-09-19 (spike7, recipient GCU6CR7T...XB22), so a port that
 * drifts from the working encoding fails here before any real burn.
 *
 * RUN: pnpm --filter @lumenia/web test:cctp-web   (offline, no keys)
 */
import {
  askRelay,
  buildForwarderHookData,
  fastMaxFee,
  forwarderBytes32,
  parseUsdc6,
  STELLAR_DOMAIN,
  STELLAR_TESTNET_FORWARDER,
  BASE_SEPOLIA_USDC,
  BASE_SEPOLIA_TOKEN_MESSENGER_V2,
} from "./cctp";

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = "") {
  console.log(`  ${cond ? "✔" : "✗"} ${name}${detail ? `  (${detail})` : ""}`);
  cond ? passed++ : failed++;
}
async function throws(name: string, fn: () => unknown, mustMention?: string) {
  try {
    await fn();
    ok(name, false, "it did NOT throw");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(name, mustMention ? msg.toLowerCase().includes(mustMention.toLowerCase()) : true, msg.slice(0, 70));
  }
}

const RECIPIENT = "GCU6CR7T7CNIFBFRAKALLG46FYHMCNRRGW5I55NE5MY6RDHXLUXXXB22";
/** Printed by spike7 on 2026-09-19 for the runs that minted. */
const GOLDEN_HOOK =
  "0x0000000000000000000000000000000000000000000000000000000000000038474355364352375437434e4946424652414b414c4c4734364659484d434e52524757354935354e45354d5936524448584c55585858423232";
const GOLDEN_FORWARDER32 = "0x3de86ac50b47eaf2840fe23e48179551660fd1072fba6f445d4a6bd7af4ab93e";

async function main() {
  console.log("[golden] the bytes that minted on 2026-09-19");
  ok("hook data matches the working encoding byte for byte", buildForwarderHookData(RECIPIENT) === GOLDEN_HOOK);
  ok("hook data is 88 bytes for a G address", (buildForwarderHookData(RECIPIENT).length - 2) / 2 === 88);
  ok("the forwarder's bytes32 matches", forwarderBytes32() === GOLDEN_FORWARDER32);
  ok("constants: Stellar is domain 27 and the forwarder is Circle's testnet one", STELLAR_DOMAIN === 27 && STELLAR_TESTNET_FORWARDER === "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ");
  ok("constants: Base Sepolia USDC and TokenMessengerV2", BASE_SEPOLIA_USDC === "0x036CbD53842c5426634e7929541eC2318f3dCF7e" && BASE_SEPOLIA_TOKEN_MESSENGER_V2 === "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA");
  await throws("a hook for something that is not a Stellar address is refused", () => buildForwarderHookData("0x18762F1CB5871147ab83598956f695fa5Dc4d03D"), "not a stellar");

  console.log("\n[amounts] 6 decimals on Base, no silent rounding");
  ok("2 -> 2,000,000 units", parseUsdc6("2") === 2_000_000n);
  ok("2.5 -> 2,500,000 units", parseUsdc6("2.5") === 2_500_000n);
  ok("0.000001 -> 1 unit", parseUsdc6("0.000001") === 1n);
  await throws("7 decimals are refused, not rounded", () => parseUsdc6("1.0000001"), "amount like");
  await throws("zero is refused", () => parseUsdc6("0"), "above zero");
  await throws("text is refused", () => parseUsdc6("two"), "amount like");
  ok("the Fast fee ceiling for 1 USDC is 201 units (2 bps + 1)", fastMaxFee(1_000_000n) === 201n);
  ok("the ceiling covers Circle's measured 1.3 bps fee on 1 USDC (130 units)", fastMaxFee(1_000_000n) > 130n);
  ok("the ceiling is never zero", fastMaxFee(1n) >= 1n);

  console.log("\n[relay] how the page reads the sponsor");
  const fake = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  const p = await askRelay("https://s.test/", "0x" + "ab".repeat(32), fake(202, { status: "pending", detail: "Circle attestation pending_confirmations" }));
  ok("202 is pending with Circle's words", p.status === "pending" && p.detail.includes("pending_confirmations"));
  const m = await askRelay("https://s.test", "0x" + "ab".repeat(32), fake(200, { status: "minted", hash: "f8c2" }));
  ok("200 minted returns the Stellar hash", m.status === "minted" && m.hash === "f8c2");
  await throws("a refusal carries the sponsor's reason", () => askRelay("https://s.test", "0x" + "ab".repeat(32), fake(503, { error: "cctp relay not configured" })), "not configured");

  console.log(`\n${failed === 0 ? "✅" : "❌"} CCTP WEB SELF-TEST ${passed}/${passed + failed}`);
  if (failed > 0) process.exit(1);
}

void main();
