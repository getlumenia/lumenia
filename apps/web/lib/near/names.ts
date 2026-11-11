// Named accounts: the recipient picks "yourname" and the contract creates <name>.<root> through the
// network's account factory. The rules here mirror what that factory accepts for one-level names.

import { isValidAccountId } from "./account-id";

export const NAME_RULES = "2 to 32 characters: a-z, 0-9, - and _";

const NAME = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/;

export type NameCheck = { ok: true; name: string; accountId: string } | { ok: false; reason: string };

/** Lowercases and trims; rejects anything the factory or the account id rules would refuse. */
export function checkName(input: string, root: string): NameCheck {
  const name = input.trim().toLowerCase();
  if (name === "") return { ok: false, reason: "Pick a name." };
  if (name.length < 2) return { ok: false, reason: "Use at least 2 characters." };
  if (name.length > 32) return { ok: false, reason: "Use at most 32 characters." };
  if (name.includes(".")) return { ok: false, reason: "No dots: the name is one word." };
  if (!NAME.test(name)) {
    return { ok: false, reason: "Only a-z, 0-9, - and _, starting and ending with a letter or digit." };
  }
  const accountId = `${name}.${root}`;
  if (!isValidAccountId(accountId)) return { ok: false, reason: "That name does not form a valid account id." };
  return { ok: true, name, accountId };
}

export type Availability = "free" | "taken" | "error";

/**
 * Maps a view_account lookup to availability: an existing account is taken, UnknownAccount means
 * the name is free, and anything else is an error the UI must show (never "free" by default).
 */
export function availabilityFromLookup(lookup: { exists: boolean } | { error: string }): Availability {
  if ("error" in lookup) return "error";
  return lookup.exists ? "taken" : "free";
}
