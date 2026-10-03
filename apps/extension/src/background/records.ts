/**
 * Link records in storage.local, one key per link (`links:<net>:<linkHex>`), scoped to the account
 * this extension holds right now. A record for any other account is neither listed nor written: a
 * late write after "Forget this account" (a settle pass that was already reading) cannot leave a
 * ghost under the next account, and a write that would do so throws, so a send stops before posting.
 */
import { asRecord, isLinkKey, linkKey, sortRecords } from "../lib/links";
import { ExtError } from "../lib/errors";
import { K, local } from "../lib/storage";
import type { LinkRecord } from "../lib/types";

/**
 * The account this extension holds, from its storage.local mirror: written when the account is
 * restored (account.ts) and removed with everything else by "Forget this account".
 */
async function heldAccount(): Promise<string | null> {
  const a = await local().get<{ pubkey?: unknown }>(K.account);
  return a && typeof a.pubkey === "string" ? a.pubkey : null;
}

export async function allRecords(): Promise<LinkRecord[]> {
  const held = await heldAccount();
  if (!held) return [];
  const all = await local().getAll();
  const out: LinkRecord[] = [];
  for (const [k, v] of Object.entries(all)) {
    if (!isLinkKey(k)) continue;
    const r = asRecord(v);
    if (r && r.sender === held) out.push(r);
  }
  return sortRecords(out);
}

export async function getRecord(linkHex: string): Promise<LinkRecord | null> {
  const held = await heldAccount();
  if (!held) return null;
  const id = linkHex.toLowerCase();
  for (const net of ["testnet", "public"] as const) {
    const r = asRecord(await local().get(linkKey(net, id)));
    if (r && r.sender === held) return r;
  }
  return null;
}

export async function putRecord(r: LinkRecord): Promise<void> {
  if ((await heldAccount()) !== r.sender) {
    throw new ExtError("internal", "That link belongs to an account this extension no longer holds.");
  }
  await local().set({ [linkKey(r.net, r.linkHex)]: r });
}
