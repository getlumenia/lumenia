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

/**
 * Check an owner proof and return what a row records of it, or null when none was offered.
 * A proof that is present but does not verify throws: a bad signature is not "no signature".
 */
async function ownerHashFrom(id: string, owner: OwnerProof | undefined): Promise<string | null> {
  if (!owner) return null;
  const pubkey = String(owner.pubkey ?? "");
  const signed = await verifyHandleProof({
    action: "links",
    name: id,
    pubkey,
    ts: Number(owner.ts),
    nonce: String(owner.nonce ?? ""),
    network: networkFromEnv(),
    proof: String(owner.proof ?? ""),
  });
  if (signed.ok !== true) throw new Error(signed.reason);
  return sha256Hex(pubkey);
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

async function getBoxAt(prefix: string, rawId: unknown): Promise<RecoveryBox | null> {
  const row = await readRow(prefix, validateId(rawId));
  return row?.box ?? null;
}

/**
 * Store the EMAIL-keyed box. Always OTP-gated at the route.
 *
 * OWNERSHIP. The code proves control of an INBOX, and the id is SHA-256 of the address it was
 * mailed to, so on its own an emailed code is the whole distance between somebody else's mailbox
 * and the only copy of their key. Creating a FIRST box asks no more than that code — a new user has
 * no account to prove yet, and a backup that is hard to make is a backup nobody has. Once a row
 * carries an owner, replacing it takes a signature from that account, so a stolen inbox cannot
 * paint over a working backup with ciphertext the owner's password cannot open.
 *
 * WHO REACHES THIS ARGUMENT. The live Worker (worker.ts /recovery) forwards `owner`, and
 * apps/web/lib/recovery-api.ts::storeRecoveryBox signs it whenever the backup flow hands it a
 * signer. Two callers still pass nothing: index.ts (the local dev server) and the web's own
 * RecoveryFlow, which does not yet forward a signer into the store step — so rows written by that
 * path remain ownerless, and a mailed code alone still replaces those.
 *
 * An ownerless row stays replaceable and adopts the first proof it is given — the same line the
 * alias rows below take, for the same reason. A row can therefore only be bound by a caller that
 * CAN sign, which is what keeps the refusals below from stranding anybody: whoever bound a row can
 * always re-prove it.
 *
 * Both refusals are PublicRefusal so their text survives on a mainnet-configured host. Neither says
 * anything the caller does not already know — it just passed the OTP for this id.
 */
export async function putBox(rawId: unknown, rawBox: unknown, owner?: OwnerProof): Promise<{ ok: true }> {
  const id = validateId(rawId);
  const box = validateBox(rawBox);
  const ownerHash = await ownerHashFrom(id, owner);
  const existing = await readRow(KEY_EMAIL, id);
  if (existing?.ownerHash) {
    if (!ownerHash) {
      throw new PublicRefusal("Replacing this backup needs a signature from the account it belongs to.");
    }
    if (ownerHash !== existing.ownerHash) {
      throw new PublicRefusal("That email already holds a backup for a different account. Use another email address for this one.");
    }
  }
  await writeRow(KEY_EMAIL, id, { box, ...(ownerHash ? { ownerHash } : {}) });
  return { ok: true };
}

/** Fetch the EMAIL-keyed box, or null. Always OTP-gated at the route. */
export async function getBox(rawId: unknown): Promise<RecoveryBox | null> {
  return getBoxAt(KEY_EMAIL, rawId);
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
  const id = validateId(rawId);
  const box = validateBox(rawBox);
  const proof = typeof rawProof === "string" && ID_RE.test(rawProof) ? rawProof : null;
  if (!proof) throw new Error("aliasProof must be a 64-char hex string");

  const proofHash = await sha256Hex(proof);
  const existing = await readRow(KEY_ALIAS, id);
  if (existing?.proofHash && existing.proofHash !== proofHash) {
    // Public for the same reason the email refusals above are: a caller that cannot read this is
    // told only "request failed", and there is no action behind that.
    throw new PublicRefusal("This Face ID backup belongs to a different passkey.");
  }
  await writeRow(KEY_ALIAS, id, { box, proofHash });
  return { ok: true };
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Fetch the PRF-alias box, or null. Read by the un-OTP'd alias route ONLY. */
export async function getAliasBox(rawId: unknown): Promise<RecoveryBox | null> {
  return getBoxAt(KEY_ALIAS, rawId);
}
