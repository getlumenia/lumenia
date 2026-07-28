import { rpc, Address, xdr } from "@stellar/stellar-sdk";
const RPC = new rpc.Server(process.env.RPC ?? "https://mainnet.sorobanrpc.com");
const id = process.env.SAC ?? "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
async function main() {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(id).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );
  const res = await RPC.getLedgerEntries(key);
  console.log(`  ${id.slice(0, 10)}… kurulu mu:`, res.entries.length > 0 ? "EVET" : "HAYIR");
  console.log("  latestLedger:", res.latestLedger);
}
main().catch((e) => { console.error("💥", e?.message ?? e); process.exit(1); });
