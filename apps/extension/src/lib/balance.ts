/**
 * How many dollars an account holds on a NAMED network.
 *
 * apps/web/lib/horizon.ts reads the network the device is switched to; a service worker has no such
 * switch, so this asks the network it is given. Pinned by issuer exactly like the website: a token
 * that merely calls itself USDC is not this money and is never shown as a balance.
 */
import { Horizon } from "@stellar/stellar-sdk";
import { USDC_ISSUER, type NetworkConfig } from "../core";
import type { BalanceInfo } from "./types";

export async function readBalance(address: string, net: NetworkConfig): Promise<BalanceInfo> {
  try {
    const acc = await new Horizon.Server(net.horizonUrl).loadAccount(address);
    const lines = acc.balances.filter((b) => "asset_code" in b && b.asset_code === "USDC") as { balance: string; asset_issuer?: string }[];
    const usdc = lines.find((b) => b.asset_issuer === USDC_ISSUER[net.id]);
    return { usd: usdc?.balance ?? "0", missing: false, line: Boolean(usdc) };
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404 || (e as { name?: string })?.name === "NotFoundError") return { usd: null, missing: true, line: false };
    return { usd: null, missing: false };
  }
}
