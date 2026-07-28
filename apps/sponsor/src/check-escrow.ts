import { rpc, Address, Contract, TransactionBuilder, Networks, scValToNative, xdr } from "@stellar/stellar-sdk";
const RPC = new rpc.Server("https://mainnet.sorobanrpc.com");
async function main() {
  const src = await RPC.getAccount("GDPKVOT7VIFJLTZR6QRLOXISA4EWORAPVHB23LSGZEBMF4KYBHJ4JWWO");
  const tx = new TransactionBuilder(src, { fee: "1000000", networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract("CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75")
      .call("balance", Address.fromString("CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4").toScVal()))
    .setTimeout(60).build();
  const sim = await RPC.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  const v = scValToNative((sim as any).result.retval) as bigint;
  console.log("  escrow:", (Number(v) / 1e7).toFixed(7), "USDC");
}
main().catch(e => { console.error("  hata:", e?.message ?? e); });
