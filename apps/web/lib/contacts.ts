import { netKey } from "./scoped-store";
/**
 * Contacts — derived entirely from YOUR OWN local history, never a server address book. When you
 * pay someone's request straight to their account (/send with a `to` address), we keep their name +
 * address locally in `lumenia.sent`; this reads those back, deduped by address, so you can pay or ask
 * the same person again without retyping anything.
 *
 * This is deliberately client-only and thin (it knows only the people YOU have paid this way, on THIS
 * device) — that is the product's whole privacy posture: no server holds a graph of who you know.
 * Nothing here leaves the browser.
 */
export interface Contact {
  name: string;
  address: string;
  lastAmount: string;
  lastAt: string; // ISO
  count: number;
}

interface SentRecord {
  amount: string;
  at: string;
  toName?: string;
  toAddress?: string;
}

/** People you've paid via their request, most-recent first, one row per person. */
export function loadContacts(): Contact[] {
  let all: Record<string, SentRecord>;
  try {
    all = JSON.parse(localStorage.getItem(netKey("lumenia.sent")) ?? "{}") as Record<string, SentRecord>;
  } catch {
    return [];
  }
  const byAddress = new Map<string, Contact>();
  for (const rec of Object.values(all)) {
    if (!rec.toAddress || !rec.toName) continue; // only direct pays carry a person + address
    const existing = byAddress.get(rec.toAddress);
    if (!existing) {
      byAddress.set(rec.toAddress, {
        name: rec.toName,
        address: rec.toAddress,
        lastAmount: rec.amount,
        lastAt: rec.at,
        count: 1,
      });
    } else {
      existing.count += 1;
      if (rec.at > existing.lastAt) {
        existing.lastAt = rec.at;
        existing.lastAmount = rec.amount;
        existing.name = rec.toName; // freshest name wins
      }
    }
  }
  return Array.from(byAddress.values()).sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
