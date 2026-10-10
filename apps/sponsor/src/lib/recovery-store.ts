/**
 * Recovery blob store — the SERVER side of the zero-knowledge recovery box
 * (RECOVERY_ARCHITECTURE §4.2 + §12 step 2). Stores ONLY ciphertext + KDF params,
 * keyed by an opaque high-entropy id (the client's hashed identity). It NEVER holds a
 * seed, password, or PRF secret, and no money data — a SEPARATE store, isolated from the
 * sponsor signing key. The endpoint touches no keys and no anti-drain policy (it signs
 * nothing).
 *
 * The one thing a row carries beyond ciphertext is a HASH of the key allowed to replace it
 * (`putBox`, `putAliasBox`). That is a write gate, not an address book: no key and no address is
 * stored, so a row names nobody — though a hash will confirm an address somebody already guesses.
 * Elsewhere this service does put an address next to a person (the pilot list); the claim made
 * here is this store's alone.
 *
 * Reuses the Upstash REST pair (kvConfigFromEnv) as a keyed value store; an in-memory
 * Map is the local/test fallback (single-process only — without KV a box would NOT
 * persist across serverless instances, which production always has).
 *
 * `validateBox` is the ciphertext-only guarantee ENFORCED server-side: a box may
 * contain ONLY the fields of a password/prf copy (iv/ct/salt/hkdfSalt/argon) — anything
 * else is rejected, so no plaintext seed/password/PRF and no PII can ever be stored.
 * The client wrap/unwrap lives in apps/web/lib/recovery.ts (Spike S1, proven 7/7).
 */
import { kvConfigFromEnv } from "./rate-limit.js";
import { PublicRefusal } from "./caps.js";
import { verifyHandleProof, type ProofInput } from "./handles.js";

const ID_RE = /^[0-9a-f]{64}$/; // SHA-256 hex — an opaque, high-entropy (256-bit) lookup key
const MAX_BOX_BYTES = 4096;

const mem = new Map<string, string>(); // local/test fallback (no KV configured)

type ArgonParams = { memMiB: number; time: number; parallelism: number };
type Copy =
  | { kind: "password"; iv: string; ct: string; salt: string; argon: ArgonParams }
  | { kind: "prf"; iv: string; ct: string; hkdfSalt: string };
export interface RecoveryBox {
  formatVersion: 1;
  copies: Copy[];
}

function isB64(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 1024 && /^[A-Za-z0-9+/=]+$/.test(s);
}
function isArgon(a: unknown): a is ArgonParams {
  if (!a || typeof a !== "object") return false;
  const p = a as Record<string, unknown>;
  // Enforce a Argon2id MINIMUM (security review F4): a box wrapped with weak params (memMiB=1,
  // time=1) is trivially crackable offline once the store leaks. OWASP floor: ≥19 MiB, ≥2 passes.
  // DEFAULT_ARGON (48/2/1) clears it; an old/buggy/malicious client can't persist a weak box.
  return (
    Object.keys(p).length === 3 &&
    typeof p.memMiB === "number" && p.memMiB >= 19 && p.memMiB <= 1024 &&
    typeof p.time === "number" && p.time >= 2 && p.time <= 16 &&
    typeof p.parallelism === "number" && p.parallelism > 0 && p.parallelism <= 8
  );
}
function isCopy(c: unknown): c is Copy {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  if (o.kind === "password") {
    return Object.keys(o).length === 5 && isB64(o.iv) && isB64(o.ct) && isB64(o.salt) && isArgon(o.argon);
  }
  if (o.kind === "prf") {
    return Object.keys(o).length === 4 && isB64(o.iv) && isB64(o.ct) && isB64(o.hkdfSalt);
  }
  return false;
}

/** Strict shape check — the ciphertext-only guarantee. Throws with a reason on mismatch. */
export function validateBox(box: unknown): RecoveryBox {
  if (!box || typeof box !== "object") throw new Error("box must be an object");
  const b = box as Record<string, unknown>;
  if (Object.keys(b).length !== 2) throw new Error("box has unexpected fields");
  if (b.formatVersion !== 1) throw new Error("unsupported box formatVersion");
  if (!Array.isArray(b.copies) || b.copies.length < 1 || b.copies.length > 3) {
    throw new Error("box.copies must be 1–3 entries");
  }
  const kinds = new Set<string>();
  for (const c of b.copies) {
    if (!isCopy(c)) throw new Error("a copy has an invalid shape (ciphertext-only fields required)");
    if (kinds.has(c.kind)) throw new Error("duplicate copy kind");
    kinds.add(c.kind);
  }
  return b as unknown as RecoveryBox;
}

function validateId(id: unknown): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("id must be a 64-char hex string");
  return id;
}

/* ---------------------------------------------------------------------------
 * TWO NAMESPACES, and the separation IS the security control.
 *
 * The email-keyed id is SHA-256(email): LOW entropy. Know somebody's email and you know their id,
 * so the mailed OTP is the only thing standing between an attacker and their box. It must stay
 * OTP-gated forever.
 *
 * The alias id is HKDF over a WebAuthn PRF output (apps/web/lib/recovery.ts::prfToBoxId): 256 bits
 * that only a user-verified passkey ceremony on this origin can produce. Possessing it already
 * proves what an OTP would prove, so the alias FETCH is deliberately not OTP-gated — that is what
 * makes "find my account with one Face ID tap, no email, no code" possible.
 *
 * Both are 64 lowercase hex and the server cannot tell them apart. So the distinction can NEVER be
 * a flag on a shared route: an un-OTP'd fetch that read the email namespace would hand any box to
 * anyone who knows the victim's email address. It has to be a different key prefix behind a
 * different route, and test-recovery-store.ts asserts the isolation in both directions.
 * --------------------------------------------------------------------------- */
const KEY_EMAIL = "lumenia:recovery:";
const KEY_ALIAS = "lumenia:recovery-pk:";

/**
 * What is actually stored. Older rows are a bare `RecoveryBox`; newer ones are wrapped so the box
 * can travel with the hash that says who may replace it. Both shapes are read.
 */
interface StoredRow {
  box: RecoveryBox;
  /** SHA-256 of the alias owner proof. Alias rows only. */
  proofHash?: string;
  /** SHA-256 of the account key that may replace this row. Email rows only. */
  ownerHash?: string;
}

/**
 * What the ACCOUNT signs to authorize a write — the same `links` proof the identity routes take,
 * over this box's id, built client-side by apps/web/lib/handles.ts::signHandleProof.
 */
export type OwnerProof = Omit<ProofInput, "action" | "name" | "network">;

/** The chain this deployment answers for: a proof signed for one must not verify on the other. */
function networkFromEnv(): "testnet" | "mainnet" {
  return process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";
}

/** What a row records of the account that may replace it: SHA-256 of its G... address. */
export async function ownerHashOf(pubkey: string): Promise<string> {
  return sha256Hex(pubkey);
}

/**
 * Verify a `links` proof by `owner` over `name` on this deployment's network: the box id for a
 * write, `check:<id>` for /recovery-check, `release:<id>` for /recovery-release. The three names
 * differ so a signature made for one of them can never be replayed as another.
 */
async function verifyOwner(
  name: string,
  owner: OwnerProof,
): Promise<{ ok: true; ownerHash: string } | { ok: false; reason: string }> {
  const pubkey = String(owner.pubkey ?? "");
  const signed = await verifyHandleProof({
    action: "links",
    name,
    pubkey,
    ts: Number(owner.ts),
    nonce: String(owner.nonce ?? ""),
    network: networkFromEnv(),
    proof: String(owner.proof ?? ""),
  });
  if (signed.ok !== true) return { ok: false, reason: signed.reason };
  return { ok: true, ownerHash: await sha256Hex(pubkey) };
}

/**
 * Check an owner proof and return what a row records of it, or null when none was offered.
 * A proof that is present but does not verify throws: a bad signature is not "no signature".
 */
async function ownerHashFrom(id: string, owner: OwnerProof | undefined): Promise<string | null> {
  if (!owner) return null;
  const verified = await verifyOwner(id, owner);
  if (!verified.ok) throw new Error(verified.reason);
  return verified.ownerHash;
}

function parseRow(raw: string): StoredRow {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (parsed && typeof parsed === "object" && "box" in parsed) return parsed as unknown as StoredRow;
  return { box: parsed as unknown as RecoveryBox }; // legacy: the value WAS the box
}

async function readRow(prefix: string, id: string): Promise<StoredRow | null> {
  const kv = kvConfigFromEnv();
  if (!kv) {
    const v = mem.get(prefix + id);
    return v ? parseRow(v) : null;
  }
  const res = await fetch(`${kv.url}/get/${prefix}${id}`, {
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
  const data = (await res.json()) as { result?: string | null };
  return data.result ? parseRow(data.result) : null;
}

async function writeRow(prefix: string, id: string, row: StoredRow): Promise<void> {
  const json = JSON.stringify(row);
  if (json.length > MAX_BOX_BYTES) throw new Error("box too large");
  const kv = kvConfigFromEnv();
  if (!kv) {
    mem.set(prefix + id, json);
    console.log(`[recovery:put] ${prefix}${id.slice(0, 8)}… (no KV — in-memory fallback)`);
    return;
  }
  const res = await fetch(`${kv.url}/set/${prefix}${id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
    body: json, // Upstash SET: the raw request body is the value
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
}

async function deleteRow(prefix: string, id: string): Promise<void> {
  const kv = kvConfigFromEnv();
  if (!kv) {
    mem.delete(prefix + id);
    return;
  }
  const res = await fetch(`${kv.url}/del/${prefix}${id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
}

async function getBoxAt(prefix: string, rawId: unknown): Promise<RecoveryBox | null> {
  const row = await readRow(prefix, validateId(rawId));
  return row?.box ?? null;
}

/**
 * The sentence every "this email is taken" answer carries. Word for word what the extension 0.1.2
 * and 0.1.3 already match (apps/extension/src/lib/backup.ts, REFUSED), so an older client that does
 * not know the 409 still shows a refusal instead of a network error.
 */
export const EMAIL_TAKEN_ERROR =
  "That email already holds a backup for a different account. Use another email address for this one.";
/** Under RECOVERY_REQUIRE_OWNER=1, an unsigned first write. */
export const OWNER_REQUIRED_ERROR =
  "Back up again from the latest version of Lumenia: this backup has to be signed by your account.";
const NEEDS_SIGNATURE_ERROR = "Replacing this backup needs a signature from the account it belongs to.";
const DIFFERENT_PASSKEY_ERROR = "This Face ID backup belongs to a different passkey.";
/** /recovery-check, /recovery-release (and /pilot-request) when the account's signature does not verify. */
export const ACCOUNT_NOT_CONFIRMED_ERROR =
  "We couldn't confirm this account signed the request. Check your device clock and try again.";
/** /recovery-release for anything but a row bound to the signer. */
export const NOT_YOURS_ERROR = "That email doesn't back up this account.";

/**
 * The email already backs up something this write may not replace: a row bound to another account
 * (`unbound` false), or an unbound row the write did not explicitly agree to replace (`unbound`
 * true). Carries the stored box, which the route hands back with its 409: the caller has just
 * proved the inbox, so it is exactly what /recovery-fetch would give them for the same code.
 * A PublicRefusal, so a route that does not catch it still shows the sentence on mainnet.
 */
export class BackupConflict extends PublicRefusal {
  readonly unbound: boolean;
  readonly box: RecoveryBox;
  constructor(unbound: boolean, box: RecoveryBox) {
    super(EMAIL_TAKEN_ERROR, "email-taken");
    this.name = "BackupConflict";
    this.unbound = unbound;
    this.box = box;
  }
}

/**
 * Store the EMAIL-keyed box. Always gated at the route by an emailed code, or by the single-use
 * ticket a 409 or a fetch handed to whoever just passed one.
 *
 * ONE EMAIL, ONE ACCOUNT. The code proves control of an INBOX, and the id is SHA-256 of the address
 * it was mailed to, so on its own an emailed code is the whole distance between somebody else's
 * mailbox and the only copy of their key. A row is therefore BOUND to the account whose signature
 * wrote it (`ownerHash`), and what a later write may do follows from that:
 *
 *   - no row: stored, and bound when the write is signed. With RECOVERY_REQUIRE_OWNER=1 an unsigned
 *     first write is refused (code owner-required): the switch for once every live client signs.
 *   - a row bound to the signer: replaced. That is a re-backup.
 *   - a row bound, and no signature: refused. A stolen inbox is not the account.
 *   - a row bound to another key: BackupConflict (unbound false). Nothing is written.
 *   - an UNBOUND row: replaced and bound only by a signed write that says `replace: true`, which a
 *     client sends after the person has seen what the row holds. Anything else is BackupConflict
 *     (unbound true) and nothing is written. Such a row used to adopt the first proof it was given,
 *     so a second account backed up under the same email silently painted over the first account's
 *     only copy, and its owner later restored a key that was not theirs.
 *
 * `replace` never overrides a bound row.
 *
 * WHO SIGNS. The Worker (worker.ts /recovery) forwards `owner`, and so does index.ts. The clients
 * sign with the account being backed up (apps/web/lib/recovery-api.ts::storeRecoveryBox when it is
 * handed a signer, the extension's backup step). The unbound rows are the ones written before the
 * binding existed (30 August 2026), and since then by a client that did not sign: the website's own
 * backup flow handed the store step no signer until the account contract (v1) made every backup
 * signed.
 *
 * The refusals are PublicRefusal so their text survives on a mainnet-configured host. None of them
 * says anything the caller does not already know: it has just passed the code for this id.
 */
export async function putBox(
  rawId: unknown,
  rawBox: unknown,
  owner?: OwnerProof,
  opts: { replace?: boolean } = {},
): Promise<{ ok: true; bound: boolean }> {
  const id = validateId(rawId);
  const box = validateBox(rawBox);
  const ownerHash = await ownerHashFrom(id, owner);
  const existing = await readRow(KEY_EMAIL, id);
  if (!existing) {
    if (!ownerHash && process.env.RECOVERY_REQUIRE_OWNER === "1") {
      throw new PublicRefusal(OWNER_REQUIRED_ERROR, "owner-required");
    }
    await writeRow(KEY_EMAIL, id, { box, ...(ownerHash ? { ownerHash } : {}) });
    return { ok: true, bound: ownerHash !== null };
  }
  if (existing.ownerHash) {
    if (!ownerHash) throw new PublicRefusal(NEEDS_SIGNATURE_ERROR);
    if (ownerHash !== existing.ownerHash) throw new BackupConflict(false, existing.box);
    await writeRow(KEY_EMAIL, id, { box, ownerHash });
    return { ok: true, bound: true };
  }
  if (ownerHash && opts.replace === true) {
    await writeRow(KEY_EMAIL, id, { box, ownerHash });
    return { ok: true, bound: true };
  }
  throw new BackupConflict(true, existing.box);
}

/**
 * Whether the email row exists and, when bound, the hash of the account it is bound to. For the
 * other registries that must agree with this one (the pilot request, the identity links). Never
 * for an answer to a caller that has not proved the inbox or signed as that account.
 */
export async function rowState(rawId: unknown): Promise<{ exists: boolean; ownerHash?: string }> {
  const row = await readRow(KEY_EMAIL, validateId(rawId));
  if (!row) return { exists: false };
  return row.ownerHash ? { exists: true, ownerHash: row.ownerHash } : { exists: true };
}

/** True only when the email row exists and is bound to `pubkey`. Throws on a store error. */
export async function isBoundTo(rawId: unknown, pubkey: string): Promise<boolean> {
  const state = await rowState(rawId);
  return state.ownerHash !== undefined && state.ownerHash === (await sha256Hex(pubkey));
}

/**
 * /recovery-check: does this email back up the account that signed? A `links` proof over
 * `check:<id>`, so no code is needed and nothing is said about anybody else: no row, an unbound row
 * and another account's row all answer `mine: false`.
 */
export async function checkMine(
  rawId: unknown,
  owner: OwnerProof,
): Promise<{ ok: true; mine: boolean } | { ok: false; reason: string }> {
  const id = validateId(rawId);
  const verified = await verifyOwner(`check:${id}`, owner);
  if (!verified.ok) return verified;
  const row = await readRow(KEY_EMAIL, id);
  return { ok: true, mine: row?.ownerHash !== undefined && row.ownerHash === verified.ownerHash };
}

/**
 * /recovery-release: the account lets go of its backup email, so that email can back up another
 * account. A `links` proof over `release:<id>`. Deletes only a row bound to the signer; any other
 * state answers `released: false` and changes nothing.
 */
export async function releaseBox(
  rawId: unknown,
  owner: OwnerProof,
): Promise<{ ok: true; released: boolean } | { ok: false; reason: string }> {
  const id = validateId(rawId);
  const verified = await verifyOwner(`release:${id}`, owner);
  if (!verified.ok) return verified;
  const row = await readRow(KEY_EMAIL, id);
  if (row?.ownerHash === undefined || row.ownerHash !== verified.ownerHash) return { ok: true, released: false };
  await deleteRow(KEY_EMAIL, id);
  return { ok: true, released: true };
}

/* ---------------------------------------------------------------------------
 * RECOVERY TICKETS. A 409 over an unbound row, and a fetch of one, hand the caller a ticket: 64 hex,
 * single use, ten minutes, valid for the one id it was minted for. It stands in for an emailed code
 * exactly once, so the person who just proved the inbox can bind or replace that row (a signed write
 * with `replace: true`) without waiting for a second code. Read and deleted in one GETDEL, so two
 * requests racing with the same ticket cannot both spend it; presenting it for another id spends it
 * too.
 * --------------------------------------------------------------------------- */
const KEY_TICKET = "lumenia:recovery-ticket:";
export const RECOVERY_TICKET_TTL_SEC = 600;
const ticketMem = new Map<string, { id: string; exp: number }>(); // local/test fallback (no KV)

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function mintRecoveryTicket(rawId: unknown): Promise<string> {
  const id = validateId(rawId);
  const ticket = randomHex(32);
  const kv = kvConfigFromEnv();
  if (!kv) {
    ticketMem.set(ticket, { id, exp: Date.now() + RECOVERY_TICKET_TTL_SEC * 1000 });
    return ticket;
  }
  const res = await fetch(`${kv.url}/set/${KEY_TICKET}${ticket}?EX=${RECOVERY_TICKET_TTL_SEC}`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}` },
    body: id, // Upstash SET: the raw request body is the value
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
  return ticket;
}

/** Spend `ticket`: true only when it exists, has not expired, and was minted for `rawId`. */
export async function consumeRecoveryTicket(rawTicket: unknown, rawId: unknown): Promise<boolean> {
  if (typeof rawTicket !== "string" || !ID_RE.test(rawTicket)) return false;
  if (typeof rawId !== "string" || !ID_RE.test(rawId)) return false;
  const kv = kvConfigFromEnv();
  if (!kv) {
    const hit = ticketMem.get(rawTicket);
    ticketMem.delete(rawTicket);
    return hit !== undefined && hit.exp > Date.now() && hit.id === rawId;
  }
  const res = await fetch(`${kv.url}/pipeline`, {
    method: "POST",
    headers: { authorization: `Bearer ${kv.token}`, "content-type": "application/json" },
    body: JSON.stringify([["GETDEL", KEY_TICKET + rawTicket]]),
  });
  if (!res.ok) throw new Error(`recovery store returned ${res.status}`);
  const [first] = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  if (first?.error) throw new Error(`recovery store error: ${first.error}`);
  return first?.result === rawId;
}

/** Fetch the EMAIL-keyed box, or null. Always OTP-gated at the route. */
export async function getBox(rawId: unknown): Promise<RecoveryBox | null> {
  return getBoxAt(KEY_EMAIL, rawId);
}

/** The EMAIL-keyed box and whether it is bound to an account, or null. Always OTP-gated at the route. */
export async function getBoxState(rawId: unknown): Promise<{ box: RecoveryBox; bound: boolean } | null> {
  const row = await readRow(KEY_EMAIL, validateId(rawId));
  return row ? { box: row.box, bound: row.ownerHash !== undefined } : null;
}

/**
 * Store the PRF-alias copy of a box. Written only from /recovery, i.e. behind the same OTP the
 * email copy is: the backup flow already holds a verified code, so piggybacking widens no surface.
 * The box is DUPLICATED rather than stored as a pointer — a pointer looks tidier but breaks the
 * moment the user re-backs-up from a device with no Face ID, leaving somebody who just passed Face
 * ID staring at "this backup has no Face ID key". A stale duplicate is harmless: the seed never
 * rotates, so an older box still restores the correct account.
 *
 * OWNERSHIP (the write-IDOR fix). The OTP proves control of the EMAIL id and nothing else, while
 * `aliasId` is a free parameter in the same request. Without a second check, anyone who can pass an
 * OTP for their OWN address could write to any alias id and, knowing a victim's, replace their box
 * with one their passkey cannot open — silently destroying the one-tap Face ID recovery for money
 * that is otherwise fine.
 *
 * So an alias row is bound to a PROOF: a second, independent HKDF output from the same passkey PRF
 * (`prfToAliasProof` in apps/web/lib/recovery.ts). Knowing an alias id does not yield it — different
 * HKDF info labels over the same secret are independent. First write records its hash; later writes
 * must present a proof that matches, or they are refused. A row written before this existed has no
 * hash and adopts the first proof it is given (there are no real-user boxes yet — recovery is still
 * owner-gated on the mailer domain).
 */
export async function putAliasBox(
  rawId: unknown,
  rawBox: unknown,
  rawProof: unknown,
): Promise<{ ok: true }> {
  const box = validateBox(rawBox);
  const { id, proofHash } = await aliasWriteCheck(rawId, rawProof);
  await writeRow(KEY_ALIAS, id, { box, proofHash });
  return { ok: true };
}

/**
 * Would `putAliasBox(rawId, ..., rawProof)` be refused? Throws the same refusal it would, writes
 * nothing. /recovery asks BEFORE it touches the email row, so a mismatched passkey can no longer
 * leave a new email row behind next to an alias write that was then refused.
 */
export async function assertAliasWritable(rawId: unknown, rawProof: unknown): Promise<void> {
  await aliasWriteCheck(rawId, rawProof);
}

async function aliasWriteCheck(rawId: unknown, rawProof: unknown): Promise<{ id: string; proofHash: string }> {
  const id = validateId(rawId);
  const proof = typeof rawProof === "string" && ID_RE.test(rawProof) ? rawProof : null;
  if (!proof) throw new Error("aliasProof must be a 64-char hex string");
  const proofHash = await sha256Hex(proof);
  const existing = await readRow(KEY_ALIAS, id);
  if (existing?.proofHash && existing.proofHash !== proofHash) {
    // Public for the same reason the email refusals above are: a caller that cannot read this is
    // told only "request failed", and there is no action behind that.
    throw new PublicRefusal(DIFFERENT_PASSKEY_ERROR);
  }
  return { id, proofHash };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fetch the PRF-alias box, or null. Read by the un-OTP'd alias route ONLY. */
export async function getAliasBox(rawId: unknown): Promise<RecoveryBox | null> {
  return getBoxAt(KEY_ALIAS, rawId);
}
