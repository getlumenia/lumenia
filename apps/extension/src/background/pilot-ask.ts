/**
 * "Ask to join real money", for the key THIS extension holds (LUMENIA ACCOUNT CONTRACT v1, 3.2 and
 * 5.2). Until 0.1.4 the only way to ask was the website's /pilot page, which files the request for
 * the website's own account: a person whose extension holds a different key could never ask for it.
 *
 * The request is signed by the account (an owner proof over the email's id, for the pilot host's own
 * network, "mainnet"), so nobody can file one for somebody else's key. The email has to be shown to
 * be the person's own: either it is the email that backs up this account (the server checks that by
 * itself), or the server asks for a code mailed to it first ("code-required"); the popup then asks
 * for that code (pilot.requestCode) and sends the request again with it.
 *
 * Every refusal that can be known here is made before anything is sent: no agreement yet, no
 * account, an account that lives only in this browser, a locked key, and an account that can
 * already use real money.
 */
import { mainnetConfig, type Signer } from "../core";
import { ExtError, MESSAGES, fail } from "../lib/errors";
import { emailId } from "../lib/identity";
import { ownerProof } from "../lib/proof";
import { normalizeCode, validEmail } from "../lib/restore";
import { pilotStanding, type Standing } from "../lib/standing";
import { readSettings } from "../lib/storage";
import { backupView, currentAccount, signerFor } from "./account";
import { cachedPilot, dropCachedPilot, pilotStatus } from "./pilot";

export interface AskResult {
  state: "pending" | "approved" | "rejected";
  /** a mail to the owner went out because of this request */
  filed: boolean;
  /** this account had asked before (or is already decided) */
  already: boolean;
  /** the short address of another account that asked with the same email in the last 90 days */
  emailAlsoFor?: string;
  /** where the account stands now, read again after the request */
  standing: Standing;
}

function pilotHost(): string {
  const m = mainnetConfig();
  if (!m) throw fail("pilot-unknown", "Real money is not available in this build.");
  return m.sponsorUrl.replace(/\/$/, "");
}

/** The refusals that need no network: consent, an account, its backup, an unlocked key. */
async function ready(): Promise<{ pubkey: string; signer: Signer }> {
  if (!(await readSettings()).consentAt) throw fail("needs-consent");
  const acct = await currentAccount();
  if (!acct) throw fail("no-account");
  if ((await backupView()).needed) throw fail("needs-backup");
  return { pubkey: acct.pubkey, signer: await signerFor(acct.pubkey) };
}

/**
 * An account that can already use real money has nothing to ask (an approved one that used all its
 * sends asks for more sends, which is allowed). Read from the answer this browser already has, never
 * from a new ask: with none, the server decides (it answers an approved account without filing).
 */
async function refuseWhenNothingToAsk(pubkey: string): Promise<void> {
  const p = await cachedPilot(pubkey);
  const s = p ? pilotStanding(p) : "unknown";
  if (s === "approved") throw new ExtError("internal", "This account is already approved for real money.");
  if (s === "open") throw new ExtError("internal", "Real money is open to everyone, so there is nothing to ask.");
}

const plain = (s: string): string => (/^[A-Z][^{}<>]{6,240}[.!?]$/.test(s.trim()) ? s.trim() : "");

/** Mail a code to `email` from the pilot host, to show the email is the person's own. */
export async function pilotRequestCode(email: string): Promise<{ codeSentAt: number }> {
  const { pubkey } = await ready();
  await refuseWhenNothingToAsk(pubkey);
  if (!validEmail(email)) throw fail("bad-email");
  let res: Response;
  try {
    res = await fetch(`${pilotHost()}/recovery-otp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: email.trim(), purpose: "pilot" }),
    });
  } catch {
    throw fail("offline");
  }
  if (res.ok) return { codeSentAt: Date.now() };
  const b = (await res.json().catch(() => null)) as { error?: unknown; code?: unknown } | null;
  if (res.status === 429) {
    throw new ExtError("rate-limited", b?.code === "otp-budget" && typeof b.error === "string" ? b.error : MESSAGES["rate-limited"]);
  }
  throw new ExtError("internal", "We couldn't send the code. Try again.");
}

/**
 * Ask to join real money (or, with no sends left, for more sends) for this extension's key, with
 * `email`, and `code` when the server asked for one. Answers where the request stands.
 */
export async function pilotRequest(email: string, code?: string): Promise<AskResult> {
  const { pubkey, signer } = await ready();
  await refuseWhenNothingToAsk(pubkey);
  if (!validEmail(email)) throw fail("bad-email");
  let c: string | undefined;
  if (code !== undefined) {
    c = normalizeCode(code);
    if (!/^\d{6}$/.test(c)) throw fail("bad-code");
  }
  const address = email.trim();
  const owner = await ownerProof(signer, "pilot", await emailId(address), "mainnet");
  let res: Response;
  try {
    res = await fetch(`${pilotHost()}/pilot-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey, email: address, owner, ...(c ? { code: c } : {}), src: "ext" }),
    });
  } catch {
    throw fail("offline");
  }
  const b = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const reason = b && typeof b.error === "string" ? b.error : "";
  if (!res.ok) {
    const why = b && typeof b.code === "string" ? b.code : "";
    if (res.status === 401 && why === "code-required") throw new ExtError("pilot-code-required", plain(reason) || MESSAGES["pilot-code-required"]);
    if (res.status === 401 && why === "bad-code") throw new ExtError("bad-code", plain(reason) || MESSAGES["bad-code"]);
    if (res.status === 401) {
      throw new ExtError("internal", plain(reason) || "We couldn't confirm this account signed the request. Check your device clock and try again.");
    }
    if (res.status === 409) {
      throw new ExtError("email-taken", plain(reason) || "That email backs up another Lumenia account. Ask with the email that backs up this one.");
    }
    if (res.status === 429) throw fail("rate-limited");
    if (res.status === 503) throw fail("pilot-unknown", plain(reason) || MESSAGES["pilot-unknown"]);
    if (res.status === 400 && /invalid email/i.test(reason)) throw fail("bad-email");
    throw new ExtError("internal", plain(reason) || "We couldn't send your request. Try again later.");
  }

  // Filed (or already decided): the cached answer is out of date, so the standing is read again.
  await dropCachedPilot(pubkey);
  const fresh = await pilotStatus(pubkey, { force: true }).catch(() => null);
  const standing: Standing = fresh ? pilotStanding(fresh) : "unknown";
  const other = b && typeof b.emailAlsoFor === "string" && /^[A-Z0-9.]{8,20}$/.test(b.emailAlsoFor) ? b.emailAlsoFor : undefined;
  const state = b?.state;
  if (state === "pending" || state === "approved" || state === "rejected") {
    return { state, filed: b?.filed === true, already: b?.already === true, ...(other ? { emailAlsoFor: other } : {}), standing };
  }
  /* An older server answers {ok:true} or {ok:true, already:true}, and quietly records nothing when the
     email was used by another wallet before. Only the standing read after it says what happened. */
  if (standing === "none") throw new ExtError("internal", "Your request didn't go through. Try again later.");
  const already = b?.already === true;
  return { state: standing === "approved" || standing === "no-sends" ? "approved" : standing === "declined" || standing === "revoked" ? "rejected" : "pending", filed: !already, already, standing };
}
