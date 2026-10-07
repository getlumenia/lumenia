/**
 * Reading and writing what a claim link carries besides its id: the #fragment (the key, and on a
 * private link the sender's name and the lock marker) and the public markers in the query.
 *
 * ONE PURE MODULE, ON PURPOSE. No @stellar/stellar-sdk, no `window` at load: the v1 claim route
 * (/c/[id]) reads a sender name out of the fragment too, and its bundle must stay as lean as it is.
 * lib/lumendrop.ts builds the v2 URL on top of this file and re-exports the pool bounds from it.
 *
 * The private fragment, in this order, each part only when it applies:
 *
 *   #<key>[&s=<encodeURIComponent(name)>][&g=<slots>][&p=1]
 *
 * The key is ALWAYS first. Base32 secrets and base64url seeds never contain '&' or '=', so splitting
 * on '&' is safe, and a name is percent-encoded, so a hostile one like `Ay&p=1#S` comes back as that
 * literal name and can never add a parameter. A fragment is never sent in an HTTP request, so the
 * name stays out of the claim page's request, its logs and every preview built from them; anyone
 * holding the whole link (the chat it travels through included) still reads it.
 */

/**
 * The query flag a sender sets, by explicit choice, to let chat previews show their name and the
 * amount (`preview=rich`). Defined here rather than in lib/link-preview.ts, which re-exports it, so
 * this module and everything that imports it (lib/lumendrop.ts, the extension) never load Next types.
 */
export const RICH_PREVIEW_PARAM = "preview";
export const RICH_PREVIEW_VALUE = "rich";

/** Pool bounds, mirroring the sponsor relay's own refusal (apps/sponsor/src/lib/soroban-relay.ts). */
export const MIN_POOL_SLOTS = 2;
export const MAX_POOL_SLOTS = 30;

/**
 * Read the `g` hint - how many shares the link SAYS it holds.
 *
 * Anything that is not a whole number inside the bounds is ignored rather than clamped: the query is
 * writable by anyone who forwards the link, and a clamped value would print a share count the escrow
 * never agreed to. The hint only decides which view is probed first and what the page renders while
 * it waits; it never decides what gets signed.
 */
export function parseSlots(raw: string | string[] | null | undefined): number | null {
  const one = Array.isArray(raw) ? raw[0] : raw;
  if (typeof one !== "string") return null;
  const trimmed = one.trim();
  // Digits only. `Number()` alone would read "0x3" and "3e0" as 3, and a share count that depends on
  // how JavaScript parses a string is not a share count.
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= MIN_POOL_SLOTS && n <= MAX_POOL_SLOTS ? n : null;
}

/** The longest sender name a claim screen prints. */
const NAME_MAX = 24;
/* What a name may not carry onto the screen: the bidi controls (the marks, ALM included, the
   embeddings and overrides, the isolates), which can make "Ayse" render as somebody else's name
   or flip the sentence around it, and every C0/C1 control. */
const UNSAFE_NAME_CHARS = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u0000-\u001F\u007F-\u009F]/g;

/**
 * The sender's name as a claim screen may print it, or null when there is none.
 *
 * Takes the RAW value, still percent-encoded, exactly as it sits in the fragment. A query value a URL
 * parser has already decoded goes through `readClaimQuery` instead, which never decodes twice.
 *
 * Decoded once (malformed -> null), stripped of bidi and control characters, trimmed, cut to 24
 * characters, empty -> null. The cut counts UTF-16 units like `slice` does, and never leaves half of
 * an emoji behind. Callers print "Someone" for null.
 */
export function sanitizeSenderName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    return null; // malformed percent-encoding is not a name
  }
  name = name.replace(UNSAFE_NAME_CHARS, "").trim().slice(0, NAME_MAX);
  if (/[\uD800-\uDBFF]$/.test(name)) name = name.slice(0, -1);
  return name || null;
}

/** What a claim fragment carries. */
export interface ClaimFragment {
  /** The key material: an S... secret, `p1.<seed>` for a password-locked link, or "" when there is none. */
  key: string;
  /** The sender's name, sanitised (see `sanitizeSenderName`), or null. */
  from: string | null;
  /** The `g` copy of the share count, through `parseSlots`. */
  slots: number | null;
  /** `p=1`. A `p1.` key is locked whatever this says; the claim page asks the key too. */
  passwordLocked: boolean;
}

/**
 * Split a claim fragment into the key and the parameters that ride behind it.
 *
 * One leading '#' is dropped (`location.hash` carries it). The first segment is the key, whatever it
 * holds. After it, `k=v` pairs: `s`, `g` and `p` are read, the FIRST occurrence of each wins, and
 * anything else (an unknown key, a bare word, an empty segment) is ignored, so a parameter added
 * later never turns into part of a key. Works the same on a pre-D2 fragment (`<key>[&g=N]`).
 */
export function parseClaimFragment(fragment: string): ClaimFragment {
  const [key = "", ...pairs] = fragment.replace(/^#/, "").split("&");
  const params = new Map<string, string>();
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const k = pair.slice(0, eq);
    if (!params.has(k)) params.set(k, pair.slice(eq + 1));
  }
  return {
    key,
    from: sanitizeSenderName(params.get("s")),
    slots: parseSlots(params.get("g")),
    passwordLocked: params.get("p") === "1",
  };
}

/* What a key is made of: base32 (an S... secret) or `p1.` and base64url (a password link's seed).
   Anything else could be read back as something else, or not read back at all. */
const FRAGMENT_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * Build the private fragment (no leading '#'): the key, then the name (left out when it is empty
 * after trimming), then the `g` copy of the share count, then `p=1` for a locked key.
 *
 * A key that is empty or holds anything but base32 and base64url characters throws: it is a bug in
 * the caller, and the link it would make could not be read back.
 */
export function claimFragment(p: { key: string; from?: string; slots?: number; passwordLocked?: boolean }): string {
  if (typeof p.key !== "string" || !FRAGMENT_KEY.test(p.key)) {
    throw new Error("a link key must be base32 or base64url characters");
  }
  const name = (p.from ?? "").trim();
  return (
    p.key +
    (name ? `&s=${encodeURIComponent(name)}` : "") +
    (p.slots !== undefined ? `&g=${p.slots}` : "") +
    (p.passwordLocked ? "&p=1" : "")
  );
}

/** What the query of a claim link says. Nothing in it is a secret, and nothing in it is proof. */
export interface ClaimQuery {
  /** `n=public`: real money. */
  mainnet: boolean;
  /** `g`, through `parseSlots`. */
  slots: number | null;
  /** `seeded=1`: the team funded this link. */
  seeded: boolean;
  /** `preview=rich`: the sender chose to show their name and the amount in chat previews. */
  rich: boolean;
  /** The query carries `a`: a pre-D2 link, or a rich one (which keeps that query byte for byte). */
  legacy: boolean;
  /** The query's `s`, sanitised, and ONLY for a rich or a legacy link. Otherwise null. */
  queryName: string | null;
  /** The query's `p=1`, and ONLY for a rich or a legacy link. A private link says it after the '#'. */
  queryLocked: boolean;
}

type QueryInput = string | URLSearchParams | Record<string, string | string[] | undefined>;

/**
 * Read a claim link's query: `location.search` (with or without its '?'), a URLSearchParams, or the
 * `searchParams` record a Next.js page is handed. Repeated keys read the first value.
 *
 * `a` is never read for anything but its presence: an amount anyone can edit is not shown anywhere.
 * `s` and `p` are believed only from the two shapes that put them in the query (a legacy link, or a
 * rich one), so a private link with `?s=` or `?p=1` appended gets neither a name nor a lock from it.
 */
export function readClaimQuery(search: QueryInput): ClaimQuery {
  const get = queryReader(search);
  const rich = get(RICH_PREVIEW_PARAM) === RICH_PREVIEW_VALUE;
  const legacy = get("a") !== undefined;
  const believed = rich || legacy;
  return {
    mainnet: get("n") === "public",
    slots: parseSlots(get("g")),
    seeded: get("seeded") === "1",
    rich,
    legacy,
    queryName: believed ? nameFromDecoded(get("s")) : null,
    queryLocked: believed && get("p") === "1",
  };
}

function queryReader(search: QueryInput): (key: string) => string | undefined {
  if (typeof search === "string" || search instanceof URLSearchParams) {
    // A query never carries a fragment. One handed in by mistake must not be read as a value.
    const sp = typeof search === "string" ? new URLSearchParams(search.split("#")[0]) : search;
    return (k) => sp.get(k) ?? undefined;
  }
  return (k) => {
    const v = search[k];
    const one = Array.isArray(v) ? v[0] : v;
    return typeof one === "string" ? one : undefined;
  };
}

/* A query value arrives already decoded. Encoding it again before the one sanitiser decodes it keeps
   a name like "100% #1" intact instead of decoding it twice (which throws, or changes it). */
function nameFromDecoded(v: string | undefined): string | null {
  if (v === undefined) return null;
  try {
    return sanitizeSenderName(encodeURIComponent(v));
  } catch {
    return null; // a lone surrogate cannot be encoded, and is not a name
  }
}
