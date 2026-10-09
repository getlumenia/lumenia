/**
 * ============================================================================
 *  SPIKE #11, state check - how long the commitment spike's ledger state stays live (testnet)
 * ============================================================================
 *
 *  Read-only: no key, no transaction. Reads, with one getLedgerEntries call, the live-until ledger of
 *  every entry the D2 spike report points at: the commitment escrow's instance and wasm, the
 *  self-issued test asset's SAC instance, the escrow's balance entry in that SAC, and the five
 *  Drop records (decoded, so the stored record can be read without an XDR tool). It also reads the
 *  network's state-archival settings, and the instance and wasm of the Groth16 verifier from spike 12.
 *
 *  Testnet archives an entry nobody extends once its live-until ledger passes (the minimum for a new
 *  persistent entry is 120,960 ledgers, about 7 days). Since protocol 23 an archived entry is
 *  restored automatically when a transaction uses it, so archived does not mean lost; this script
 *  shows whether anything is close to it. ops/RUNBOOK_STATE_EXPIRY.md has the extend recipe.
 *
 *  RUN:  pnpm --filter @lumenia/sponsor exec tsx src/spike11-ttl.ts      (prints JSON)
 * ============================================================================
 */
import { Address, Networks, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

const RPC_URL = "https://soroban-testnet.stellar.org";
/** Measured over 100,000 testnet ledgers on 2026-10-08 (Horizon /ledgers): 5.0 s a ledger. */
const SECONDS_PER_LEDGER = 5;

/** The commitment spike (evidence/ZK_SPIKE_REPORT.md, Deployment). */
const SPIKE = "CAGWIGEGGTPZK7SPERJRW3EYSEHGSZKQEKEH6SU4ECU6EI7BKTAILCXA";
const SPIKE_WASM = "0a7dbe551dacffc8894f8a20d7afaf72bd77e263c25b627d5d35e45a2d7e5ee4";
const SAC = "CCX2B4R3UOJWUO7H2CIKEFPZP7J54ULHXKRRBQXAQSEQGWEYTSYCMWME";
/** The five commitment drops of the measurement run (evidence/spike11/measurements.json, run 0 to 4). */
const LINKS = [
  "d66b6140e8e985073425384ad1adec91c7639aa8b54190f7e70450914cc90049",
  "54757d63c6dce23ab467e5df6b00415ec71e6eea0aa2245e443f2cdb413eef2b",
  "3394b587697001dbbaa7c24cb96521d3434d2d7d7af6cdcf37a2ee7b6dd9f260",
  "b2caaef7e4872a48c3d38257d3bd98be02707b057a6c02e53ac6eff5d74f243c",
  "20875063badbd937bf2da9c69180a1f55956178ef0ce91532cb77d2e1ea37001",
];
/** The upstream Groth16 verifier deployed by spike 12 (evidence/spike11/tier2/onchain.json). */
const VERIFIER = "CBMYSVI2KCESZC6BNAKDTKHJKIA22EKXLOILPYVPQYIGVJ44R7PL75MD";
const VERIFIER_WASM = "40706c83e703e9173ea1b1ad32ee84b19f0d26125349fe0f904f6c39364344c1";

const persistent = () => xdr.ContractDataDurability.persistent();
const dataKey = (contract: string, key: xdr.ScVal) =>
  xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: Address.fromString(contract).toScAddress(), key, durability: persistent() }));
const instanceKey = (contract: string) => dataKey(contract, xdr.ScVal.scvLedgerKeyContractInstance());
const codeKey = (h: string) => xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(h, "hex") }));
const dropKey = (link: string) => dataKey(SPIKE, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Drop"), xdr.ScVal.scvBytes(Buffer.from(link, "hex"))]));
const balanceKey = (holder: string) => dataKey(SAC, xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Balance"), Address.fromString(holder).toScVal()]));

const ENTRIES: [string, xdr.LedgerKey][] = [
  [`commitment escrow instance ${SPIKE}`, instanceKey(SPIKE)],
  [`commitment escrow wasm ${SPIKE_WASM}`, codeKey(SPIKE_WASM)],
  [`test asset SAC instance ${SAC}`, instanceKey(SAC)],
  ["test asset balance of the escrow (SAC Balance entry)", balanceKey(SPIKE)],
  ...LINKS.map((l, i): [string, xdr.LedgerKey] => [`Drop record #${i} (link ${l})`, dropKey(l)]),
  [`Groth16 verifier instance ${VERIFIER}`, instanceKey(VERIFIER)],
  [`Groth16 verifier wasm ${VERIFIER_WASM}`, codeKey(VERIFIER_WASM)],
];

async function main(): Promise<void> {
  const server = new rpc.Server(RPC_URL);
  const net = await server.getNetwork();
  if (net.passphrase !== Networks.TESTNET) throw new Error(`the RPC serves "${net.passphrase}", not testnet`);
  const latest = await server.getLatestLedger();
  const res = await server.getLedgerEntries(...ENTRIES.map(([, k]) => k));
  const byKey = new Map(res.entries.map((e) => [e.key.toXDR("base64"), e]));
  const now = Date.now();
  const entries = ENTRIES.map(([label, key]) => {
    const e = byKey.get(key.toXDR("base64"));
    if (!e) return { label, found: false };
    const left = e.liveUntilLedgerSeq !== undefined ? e.liveUntilLedgerSeq - latest.sequence : null;
    const row: Record<string, unknown> = {
      label,
      found: true,
      lastModifiedLedgerSeq: e.lastModifiedLedgerSeq,
      liveUntilLedgerSeq: e.liveUntilLedgerSeq,
      ledgersLeft: left,
      archived: left !== null && left < 0,
      aboutUntil: left !== null ? new Date(now + left * SECONDS_PER_LEDGER * 1000).toISOString().slice(0, 10) : null,
    };
    if (label.startsWith("Drop record")) {
      const [variant, d] = scValToNative(e.val.contractData().val()) as [string, Record<string, unknown>];
      row.value = {
        variant,
        sender: d.sender,
        commitment: Buffer.from(d.commitment as Uint8Array).toString("hex"),
        escrowed: String(d.escrowed),
        expiry: String(d.expiry),
        claimed: d.claimed,
      };
    }
    if (label.startsWith("test asset balance")) row.value = scValToNative(e.val.contractData().val());
    return row;
  });
  const cfg = await server.getLedgerEntries(
    xdr.LedgerKey.configSetting(new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingStateArchival() })),
  );
  const sa = cfg.entries[0]?.val.configSetting().stateArchivalSettings();
  const out = {
    readAt: new Date(now).toISOString(),
    rpc: RPC_URL,
    method: "getLedgerEntries (read-only)",
    latestLedger: latest.sequence,
    protocolVersion: latest.protocolVersion,
    stateArchival: sa
      ? { maxEntryTtl: sa.maxEntryTtl(), minPersistentTtl: sa.minPersistentTtl(), minTemporaryTtl: sa.minTemporaryTtl() }
      : null,
    entries,
  };
  console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
