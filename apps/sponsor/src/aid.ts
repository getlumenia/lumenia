/**
 * Print the hashed account id (`aid`) the event beacon uses for a Stellar address, so an operator
 * can put the team's own accounts into `EVENTS_EXCLUDE_AIDS` without ever sending an address to
 * the Worker. Same derivation as apps/web/lib/events.ts::hashId: SHA-256, first 8 bytes, hex.
 *
 * RUN: pnpm --filter @lumenia/sponsor aid GABC... [GDEF...]
 */
import { createHash } from "node:crypto";

const addresses = process.argv.slice(2).map((a) => a.trim()).filter(Boolean);
if (addresses.length === 0) {
  console.error("usage: pnpm --filter @lumenia/sponsor aid <G...> [<G...> ...]");
  process.exit(2);
}
for (const address of addresses) {
  if (!/^[GM][A-Z2-7]{55}$|^M[A-Z2-7]{68}$/.test(address)) {
    console.error(`not a Stellar address: ${address}`);
    process.exit(2);
  }
  console.log(`${address}  ${createHash("sha256").update(address).digest("hex").slice(0, 16)}`);
}
