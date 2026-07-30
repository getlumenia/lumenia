#!/usr/bin/env node
/**
 * pilot — owner CLI for the user-funded mainnet pilot allowlist.
 *
 * Adds / removes / checks a wallet in the SAME Upstash store the Worker's pilot guard reads
 * (lib/pilot.ts). Namespaced by STELLAR_NETWORK, so run it with the SAME network + KV env the
 * mainnet Worker uses, or you'll write to the testnet namespace by mistake (the output names
 * the network so you can catch that).
 *
 *   RUN:  STELLAR_NETWORK=mainnet KV_REST_API_URL=… KV_REST_API_TOKEN=… \
 *           pnpm --filter @lumenia/sponsor pilot approve G...
 *         …pilot revoke G...    |    …pilot status G...
 *   NEEDS: KV_REST_API_URL / KV_REST_API_TOKEN (Upstash). No signing keys — this only writes
 *          an allowlist flag, it never touches money.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { approvePilot, revokePilot, pilotStatus } from "../lib/pilot.js";

async function main(): Promise<void> {
  const [cmd, pubkey] = process.argv.slice(2);
  const net = process.env.STELLAR_NETWORK ?? "testnet";

  if (!cmd || !["approve", "revoke", "status"].includes(cmd) || !pubkey) {
    console.error("usage: pilot <approve|revoke|status> <G...pubkey>");
    process.exit(1);
  }
  if (!StrKey.isValidEd25519PublicKey(pubkey)) {
    console.error(`not a valid Stellar public key: ${pubkey}`);
    process.exit(1);
  }

  switch (cmd) {
    case "approve": {
      await approvePilot(pubkey);
      const s = await pilotStatus(pubkey);
      console.log(`approved for the ${net} pilot: ${pubkey}`);
      console.log(`  budget: ${s.limit} transactions`);
      break;
    }
    case "revoke": {
      await revokePilot(pubkey);
      console.log(`revoked from the ${net} pilot: ${pubkey}`);
      break;
    }
    case "status": {
      const s = await pilotStatus(pubkey);
      console.log(`${net} pilot — ${pubkey}`);
      console.log(`  approved: ${s.approved}`);
      console.log(`  used:     ${s.used} / ${s.limit}`);
      break;
    }
  }
}

main().catch((e) => {
  console.error(`pilot CLI error: ${(e as Error).message}`);
  process.exit(1);
});
