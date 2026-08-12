/**
 * Network-scoped localStorage keys.
 *
 * One build serves testnet and mainnet, and the device chooses at runtime — but the local records
 * were written to a single shared key, so practice data and real-money data piled into the same
 * bucket. The consequences were not cosmetic:
 *
 *  - `/sent/[id]` looked a testnet send's id up against the mainnet ledger, found nothing, and
 *    rendered "This money has been received. Nothing more to do." — a settlement claim about a
 *    transfer that is still sitting unclaimed on the other network.
 *  - Contacts you had only ever paid with play money were offered as "pay again" on real money.
 *  - `loadReclaimableV2` probed testnet drop ids against the mainnet escrow on every notification
 *    poll, and any "take it back" button it produced would have signed for the wrong chain.
 *  - The saved cash-out address — sold in the copy as "the last destination that actually WORKED" —
 *    auto-filled a real-money withdrawal with an address verified only on testnet.
 *
 * The fix is a key suffix rather than a field on each record, because a filter is something a
 * future reader can forget to apply and a key is not. Reads of the other network's data do not
 * return the wrong thing; they return nothing, which every caller already handles.
 *
 * The keystore is deliberately NOT scoped: a seed is chain-agnostic and the same address exists on
 * both networks, so scoping it would strand people's accounts.
 */
import { activeNetwork } from "./network";

/** Bases that were shared before scoping, and are migrated once to the testnet namespace. */
const MIGRATED_BASES = [
  "lumenia.sent",
  "lumenia.asks",
  "lumenia.sendout.destination",
  "lumenia.sendout.draft",
  "lumenia.notif.seen",
] as const;

const MIGRATION_FLAG = "lumenia.scoped.v1";

/**
 * Move pre-scoping records into the testnet namespace, once.
 *
 * Everything written before this change was testnet: mainnet was gated behind a pilot allowlist
 * that no external wallet had passed. So "assume testnet" is not a guess to be safe, it is what
 * the data is — and it keeps every existing user's practice history visible instead of appearing
 * to delete it.
 *
 * Runs at module load rather than from an effect, so it cannot lose a race with a page component
 * that reads on mount.
 */
function migrateOnce(): void {
  if (typeof window === "undefined") return;
  try {
    if (localStorage.getItem(MIGRATION_FLAG) === "1") return;
    for (const base of MIGRATED_BASES) {
      const legacy = localStorage.getItem(base);
      if (legacy === null) continue;
      const target = `${base}.testnet`;
      // Never clobber: if a scoped value somehow exists already, it is the newer truth.
      if (localStorage.getItem(target) === null) localStorage.setItem(target, legacy);
      localStorage.removeItem(base);
    }
    localStorage.setItem(MIGRATION_FLAG, "1");
  } catch {
    /* storage blocked (private mode, embedded webview) — scoped reads just start empty */
  }
}

migrateOnce();

/** The key for `base` on the network this device is on right now. */
export function netKey(base: string): string {
  return `${base}.${activeNetwork().id}`;
}
