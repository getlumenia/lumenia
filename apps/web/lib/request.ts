/**
 * Request money — "ask someone to pay you with a link" (REQUEST_MONEY.md §10).
 *
 * THE DECISION this module implements (§5.1, argued in writing as required):
 *
 * A request link carries NO custody. It is `/r/<nonce>?a=<amount>&n=<name>` — public
 * metadata only, nothing to steal, nothing to lose. Who the money ends up with is
 * decided by what the ASKER already has:
 *
 *  - FIRST-TIME asker (no local account): the payer pays through the existing
 *    `createSendLink()` — a bearer claim link — and sends it back into the same
 *    chat thread the request arrived from. The thread is the return channel.
 *    Value-first holds: the asker sets up nothing until money exists.
 *  - RETURNING asker (`useWallet()` has an address): the link also carries
 *    `to=<G...>`, and the payer's send creates the Claimable Balance with the
 *    ASKER'S ADDRESS as the unconditional claimant (payer keeps the reclaim-7d
 *    claimant). The asker collects it on /home with her existing account. Both
 *    policy gates accept this shape UNCHANGED — proven on testnet by Spike #6
 *    (apps/sponsor/src/spike6-request-pay.ts, 8/8).
 *
 * Why not a bearer-key request (option A): the request link must never carry the
 * secret (the payer could take the money back), so A needs TWO links — one to
 * share, one to keep — on the surface that can least afford confusion; and
 * localStorage inside a WhatsApp webview is not durable enough to hold the only
 * key to money. Why not an account at request time (option B): it violates
 * value-first (custody before any money exists) and burns a sponsored reserve per
 * possibly-never-paid request — a griefing vector priced in the sponsor's XLM.
 *
 * SEP-7 (§5.2): NOT in v1. A `web+stellar:pay` URI cannot express the first-time
 * ask at all (no destination account), and for returning askers it delivers a
 * plain payment with no reclaim predicate — the payer would silently lose the
 * "comes back after 7 days" promise. The `to` param already carries everything a
 * SEP-7 URI needs, so offering "pay from any Stellar wallet" later is additive.
 *
 * The nonce is the request funnel's shared id (§5.3): request_created /
 * request_opened / request_paid all carry its hash, so created → opened → paid is
 * joinable end-to-end — the first fully joinable funnel in the product.
 */
import { StrKey } from "@stellar/stellar-sdk";

import { netKey } from "./scoped-store";
export interface Ask {
  nonce: string;
  /** Requested amount, "12.34" (always 2dp). */
  amount: string;
  /** The asker's display name. */
  name: string;
  /** The asker's account address — present only for a returning asker. */
  to?: string;
}

export interface AskRecord extends Ask {
  link: string;
  at: string; // ISO timestamp
}

const NAME_MAX = 40;
const STORE_KEY = () => netKey("lumenia.asks");

/** URL-safe random id — the request funnel's join key, not a secret. */
export function makeNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => "abcdefghijklmnopqrstuvwxyz234567"[b % 32]).join("");
}

export function buildRequestLink(origin: string, ask: Ask): string {
  const q = new URLSearchParams({ a: ask.amount, n: ask.name });
  if (ask.to) q.set("to", ask.to);
  return `${origin.replace(/\/$/, "")}/r/${ask.nonce}?${q.toString()}`;
}

/**
 * Validate the pieces of an opened request link. Anything malformed returns null
 * and the page shows an honest "ask them to send it again" — never a broken form.
 */
export function parseAsk(nonce: string, params: { a?: string; n?: string; to?: string }): Ask | null {
  if (!/^[a-z2-7]{4,32}$/.test(nonce)) return null;
  const amount = Number.parseFloat(params.a ?? "");
  if (!Number.isFinite(amount) || amount <= 0 || amount >= 1_000_000_000) return null;
  const name = (params.n ?? "").trim().slice(0, NAME_MAX);
  if (!name) return null;
  const to = params.to;
  if (to !== undefined && !StrKey.isValidEd25519PublicKey(to)) return null;
  return { nonce, amount: amount.toFixed(2), name, to };
}

export function clampAskName(name: string): string {
  return name.trim().slice(0, NAME_MAX);
}

export function isValidAddress(addr: string): boolean {
  return StrKey.isValidEd25519PublicKey(addr);
}

/** Local-only history so the asker can re-copy a link. Never sent to a server. */
export function saveAsk(rec: AskRecord): void {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY()) ?? "{}") as Record<string, AskRecord>;
    all[rec.nonce] = rec;
    localStorage.setItem(STORE_KEY(), JSON.stringify(all));
  } catch {
    /* localStorage blocked — the link still works, just no local history */
  }
}

export function loadAsks(): AskRecord[] {
  try {
    const all = JSON.parse(localStorage.getItem(STORE_KEY()) ?? "{}") as Record<string, AskRecord>;
    return Object.values(all).sort((x, y) => y.at.localeCompare(x.at));
  } catch {
    return [];
  }
}
