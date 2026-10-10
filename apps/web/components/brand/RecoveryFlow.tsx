"use client";

/**
 * RecoveryFlow: "Back up your money" (secure) / "Restore my money" (restore) / "Bring another
 * account here" (add), RECOVERY_ARCHITECTURE section 12 step 4. Value-first + vocabulary-clean: money +
 * people, "your password", "your email", never wallet/crypto/seed jargon. The seed never leaves
 * lib/wallet.tsx + lib/recovery.ts + lib/account-add.ts; this component only moves an email, a
 * one-time code, a password (never stored or sent raw), ciphertext, and a signer handle the store
 * step uses to prove the account owns the row. Warm-paper (app) styling.
 *
 * Flow: email → 6-digit code (emailed) → password → done. On restore the fetched box is
 * cached, so a wrong password retries without a fresh code. Argon2id params are the
 * provisional DEFAULT_ARGON, tuned later from the on-device Spike #3 measurement.
 *
 * On the "secure" side the STORE happens before the device is locked (lib/wallet.tsx passes the
 * store step in as `commit`), so a wrong or expired code leaves the account exactly as it was.
 *
 * ONE EMAIL, ONE ACCOUNT (LUMENIA ACCOUNT CONTRACT v1, sections 2, 5.4, 5.5). Every backup is signed
 * by the account it backs up (lib/recovery-client.ts storeBox). When the email already backs up
 * ANOTHER account the server stores nothing and says so, after the code proved the inbox is theirs,
 * and this flow offers the honest ways on: it tries the password just typed on that stored backup
 *   - it opens to THIS account: their own older backup, tied to this account with the ticket;
 *   - it opens to another account: offer to bring that one here, and to use another email for this;
 *   - it does not open: ask for that backup's password, or another email, and only for a backup
 *     tied to no account, "Replace it" behind a typed REPLACE.
 * It never overwrites another account's backup and never forks one silently.
 */
import { useEffect, useRef, useState } from "react";
import { PrimaryButton } from "./PrimaryButton";
import { useWallet } from "../../lib/wallet";
import { requestRecoveryOtp } from "../../lib/recovery-api";
import { findCopy, type PrfCopy, type RecoveryBox } from "../../lib/recovery";
import { isPlatformAuthenticatorAvailable } from "../../lib/passkey-prf";
import { passwordStrength } from "../../lib/password-strength";
import {
  BackupConflict,
  EMAIL_HINT,
  RecoveryRefusal,
  TICKET_EXPIRED,
  conflictPlan,
  fetchBox,
  releaseEmail,
  storeBox,
  tieRestored,
  type ConflictPlan,
} from "../../lib/recovery-client";
import { backupRecord, markBackedUp, recordEmailChange } from "../../lib/backup-record";
import { accountLine, maskEmail, shortAddress } from "../../lib/account-label";
import { boxOpensTo, WRONG_BACKUP_PASSWORD } from "../../lib/account-add";
import type { Signer } from "../../lib/signer";

const field = "w-full rounded-[14px] border border-line bg-paper px-3 py-3 text-[16px] text-ink";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const REPLACE_WORD = "REPLACE";
const quiet = "text-sm font-semibold text-money underline-offset-2 hover:underline disabled:opacity-50";

/** What came back from the server for a backup this email already holds for another account. */
interface Conflict {
  box: RecoveryBox;
  unbound: boolean;
  ticket?: string;
  plan: ConflictPlan;
  /** The account the stored backup opened to, and the password that opened it (offer-bring). */
  other?: { address: string; password: string };
}

/** What one store answered: the binding, and (changing the email) what became of the old one. */
interface Stored {
  bound: boolean | null;
  release?: "released" | "not-yours" | "unknown";
}

/** The stored backup opens this account, but its row is tied to another key. */
const TIED_ELSEWHERE = "That backup opens this account, but it is tied to another one. Use another email for this backup.";

/** A wrong password on a box is an AES-GCM failure; say what it means. */
function readable(e: unknown): string {
  const err = e as { name?: string; message?: string };
  if (err?.name === "OperationError") return WRONG_BACKUP_PASSWORD;
  return err?.message ?? "Something went wrong. Try again.";
}

export function RecoveryFlow({
  mode,
  onDone,
  replaceEmail,
  initialEmail,
}: {
  mode: "secure" | "restore" | "add";
  /** Told once the backup is stored, or the money is restored (add: once the person chose). */
  onDone?: () => void;
  /** secure only: the email this account is backed up with now, released once the new one is stored. */
  replaceEmail?: string;
  /** Pre-fills the email field (the account's recorded backup email). */
  initialEmail?: string;
}) {
  const { account, secureRecovery, restoreRecovery, addRestoredAccount, addFaceIdBackup, restoreWithFaceId, switchAccount } = useWallet();
  const secure = mode === "secure";
  const adding = mode === "add";
  /* In "secure" mode the SAME field means two opposite things, and saying "Choose a password" for
     both is what made this unusable: on a Phase-1 account the password you type BECOMES the
     password, but on an already-locked one secureRecovery VERIFIES it against the existing one and
     throws if it differs. Someone with a two-week-old password read "Choose a password", typed a
     new one, and was told it was wrong — correct behaviour, incomprehensible screen. */
  const alreadyLocked = secure && account?.phase === 2;
  const [step, setStep] = useState<"start" | "code" | "conflict" | "done">("start");
  const [email, setEmail] = useState(initialEmail ?? "");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  /* An account locked before the strength floor existed cannot back up under that password — it
     would become the key to ciphertext an attacker can fetch and grind offline. Replacing it is
     the way through. Revealed only after a submit attempt, so the extra fields don't blink in and
     out of the form while somebody is still typing. */
  const [rekey, setRekey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [fetched, setFetched] = useState<{ box: RecoveryBox; bound: boolean | null; ticket?: string } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [otherPassword, setOtherPassword] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [replaceTyped, setReplaceTyped] = useState("");
  /** The closing sentence, and (add mode) the account that was brought here. */
  const [doneText, setDoneText] = useState("");
  const [doneLine, setDoneLine] = useState("");
  const [added, setAdded] = useState<{ address: string; alreadyHere: boolean } | null>(null);
  // Face ID is a REAL-BROWSER upgrade — only offer it where a platform authenticator exists
  // (never in the WhatsApp webview, which can't create passkeys; the password floor stays).
  const [faceCapable, setFaceCapable] = useState(false);
  const [addFaceId, setAddFaceId] = useState(false);
  /** The Face ID copy made on the first attempt, reused if a conflict asks for a second store. */
  const faceCopy = useRef<{ copy: PrfCopy; aliasId: string; aliasProof: string } | null>(null);
  useEffect(() => {
    let live = true;
    void isPlatformAuthenticatorAvailable().then((ok) => live && setFaceCapable(ok));
    return () => {
      live = false;
    };
  }, []);

  const typedEmail = email.trim();
  const emailOk = EMAIL_RE.test(typedEmail);
  const codeOk = /^\d{6}$/.test(code.trim());
  // Setting a NEW recovery password must clear the strength floor (F1 — the password copy is
  // offline-crackable if the store leaks); entering an EXISTING one on restore just needs length.
  /* The strength floor applies to a password being CHOSEN. Applying it to one being VERIFIED locks
     people out of their own account: a password set before the floor existed would be refused by
     the client before it ever got the chance to decrypt anything. */
  const settingNew = secure && !alreadyLocked;
  // The field that OPENS an existing account only has to be plausible.
  const openOk = settingNew || password.length >= 6;
  /* The floor lives on whichever field will WRAP the box — the chosen one on a fresh account, the
     replacement on a re-key. lib/wallet.tsx::secureRecovery refuses a weak key at the wrap too, so
     this form is never the only guard. */
  const choosing = settingNew || rekey;
  const chosen = settingNew ? password : newPassword;
  const chosenCheck = passwordStrength(chosen);
  const matches = confirm === chosen;
  const pwOk = openOk && (!choosing || (chosenCheck.ok && matches));
  const short = account ? shortAddress(account.address) : "";

  async function sendCode() {
    setError("");
    setBusy(true);
    try {
      await requestRecoveryOtp(typedEmail);
      setStep("code");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * Back to the email step, with nothing of this email's answers carried over. After a conflict the
   * field is emptied (that email is taken); from the code step it keeps what was typed, so a typo
   * can be fixed rather than retyped.
   */
  function chooseAnotherEmail(keepTyped = false) {
    setAdded(null);
    setDoneText("");
    setDoneLine("");
    setConflict(null);
    setFetched(null);
    setReplacing(false);
    setReplaceTyped("");
    setOtherPassword("");
    setCode("");
    if (!keepTyped) setEmail("");
    setError("");
    setStep("start");
  }

  /**
   * One store, inside secureRecovery so the device is locked only once it has landed. `ticket`
   * stands in for the code after a conflict, with `replace` (lib/recovery-client.ts storeBox).
   */
  async function storeThroughWallet(opts: { ticket?: string; replace?: boolean }): Promise<Stored> {
    let bound: boolean | null = null;
    let release: Stored["release"];
    await secureRecovery(
      password,
      async (box, signer) => {
        // The alias id is what makes a later "find my money with Face ID" possible: a second
        // copy of this same ciphertext, stored where only this passkey can address it. Stored
        // in the same request, behind the same verified code (or the ticket that stands for it).
        let sealed = box;
        let alias: { aliasId: string; aliasProof: string } | undefined;
        if (faceCopy.current) {
          sealed = { ...box, copies: [...box.copies.filter((c) => c.kind !== "prf"), faceCopy.current.copy] };
          alias = { aliasId: faceCopy.current.aliasId, aliasProof: faceCopy.current.aliasProof };
        } else if (addFaceId && faceCapable) {
          try {
            const withFace = await addFaceIdBackup(sealed); // a second (Face ID) copy before storing
            const copy = findCopy(withFace.box, "prf");
            if (copy) faceCopy.current = { copy, aliasId: withFace.aliasId, aliasProof: withFace.aliasProof };
            sealed = withFace.box;
            alias = { aliasId: withFace.aliasId, aliasProof: withFace.aliasProof };
          } catch {
            /* declined / unavailable on this device → ship the password-only box (still a full backup) */
          }
        }
        /* Signed by the key being backed up, which secureRecovery hands over from the seed it just
           opened. That is what ties the row to THIS account: the emailed code only proves an inbox,
           and an unsigned row is replaceable by anyone who can read the next code. */
        const stored = await storeBox({
          email: typedEmail,
          box: sealed,
          ...(opts.ticket ? { ticket: opts.ticket, replace: opts.replace } : { code: code.trim() }),
          signer,
          alias,
        });
        bound = stored.bound;
        /* Change backup email (W14): the new row is stored, so untie the old one from this account.
           "not-yours" (the old row is tied to no account, or another) and "unknown" (an older
           server) leave the old email listed as one that may still open this account. */
        if (replaceEmail && replaceEmail.trim().toLowerCase() !== typedEmail.toLowerCase()) {
          release = await releaseEmail(replaceEmail, signer);
        }
      },
      rekey ? newPassword : undefined,
    );
    return { bound, release };
  }

  function finishSecure({ bound, release }: Stored, own: boolean) {
    if (!account) return;
    // Only now is "backed up" true, and for which email.
    if (replaceEmail && release) {
      recordEmailChange(account.address, { oldEmail: replaceEmail, newEmail: typedEmail, bound, release });
    } else {
      markBackedUp(account.address, typedEmail, bound);
    }
    setDoneText(
      own
        ? `Backed up. This email now opens this account (${short}).`
        : rekey
          ? "Your money is backed up, and the new password is the one that opens it from now on."
          : "Your money is backed up. On a new phone, your email and password bring it back.",
    );
    setDoneLine(accountLine(account.address, backupRecord(account.address)).text);
    setStep("done");
    onDone?.();
  }

  /** A conflict came back: try the password already typed on the stored box, then decide (contract 5.4). */
  async function onConflict(c: BackupConflict) {
    if (!account) return;
    let opened = await boxOpensTo(c.box, password);
    let openedWith = password;
    if (!opened && rekey && newPassword) {
      opened = await boxOpensTo(c.box, newPassword);
      openedWith = newPassword;
    }
    const plan = conflictPlan(opened, account.address, c.unbound);
    if (plan.kind === "bind-own" && c.ticket) {
      await bindOwn(c.ticket);
      return;
    }
    // It opens to this account but is tied to another key: nothing here can untie it.
    if (plan.kind === "bind-own") setError(TIED_ELSEWHERE);
    setConflict({
      box: c.box,
      unbound: c.unbound,
      ticket: c.ticket,
      plan: plan.kind === "bind-own" ? { kind: "ask-password", offerReplace: false } : plan,
      ...(plan.kind === "offer-bring" && opened ? { other: { address: opened, password: openedWith } } : {}),
    });
    setStep("conflict");
  }

  /** Their own older backup, tied to no account yet: tie it to this account with the ticket. */
  async function bindOwn(ticket: string) {
    finishSecure(await storeThroughWallet({ ticket, replace: true }), true);
  }

  /** A refused store after a conflict: the ticket is single use and lives 600 seconds. */
  function onTicketRefused(e: unknown): boolean {
    if (e instanceof RecoveryRefusal && e.status === 401) {
      setConflict(null);
      setCode("");
      setStep("code");
      setError(TICKET_EXPIRED);
      return true;
    }
    return false;
  }

  /**
   * After a restore: tie an untied row to the account it opened (the same box, the ticket, the
   * restored key), or ask whether it already is. Never throws: the account is back either way, and
   * an answer we could not get is recorded as unknown.
   */
  async function tieAfterRestore(f: { box: RecoveryBox; bound: boolean | null; ticket?: string }, signer: Signer): Promise<boolean | null> {
    // lib/recovery-client.ts tieRestored: a failed bind of an untied row records false, as the
    // extension's does, so the account line offers "Back it up again" rather than "backed up with".
    return tieRestored(typedEmail, f, signer);
  }

  async function fetchedBox(): Promise<{ box: RecoveryBox; bound: boolean | null; ticket?: string }> {
    if (fetched) return fetched;
    const f = await fetchBox(typedEmail, code.trim());
    if (!f) throw new Error("No backup was found for that email.");
    setFetched(f); // cache so a wrong password retries without a fresh code
    return f;
  }

  async function finish() {
    setError("");
    if (secure && !choosing && !passwordStrength(password).ok) {
      // Ask for a replacement rather than letting the wrap refuse it: the password they just typed
      // is the one they already have, and there is no other way for them to get a backup at all.
      setRekey(true);
      return;
    }
    setBusy(true);
    try {
      if (secure) {
        try {
          finishSecure(await storeThroughWallet({}), false);
        } catch (e) {
          if (e instanceof BackupConflict) {
            await onConflict(e);
            return;
          }
          throw e;
        }
        return;
      }
      const f = await fetchedBox();
      let tied: boolean | null = null;
      if (adding) {
        const r = await addRestoredAccount(f.box, password, async (signer) => {
          tied = await tieAfterRestore(f, signer);
        });
        markBackedUp(r.address, typedEmail, tied);
        setAdded(r);
        setDoneText(`This is ${shortAddress(r.address)}, backed up with ${maskEmail(typedEmail)}.`);
        setStep("done");
        return; // onDone waits for "Use it now" or "Not now"
      }
      const { address } = await restoreRecovery(f.box, password, async (signer) => {
        tied = await tieAfterRestore(f, signer);
      });
      markBackedUp(address, typedEmail, tied);
      setDoneText(`This is ${shortAddress(address)}, backed up with ${maskEmail(typedEmail)}.`);
      setStep("done");
      onDone?.();
    } catch (e) {
      if (!onTicketRefused(e)) setError(readable(e));
    } finally {
      setBusy(false);
    }
  }

  /** Restore path via Face ID (real browser) — fetches the box (email + code), then opens its
   *  PRF copy with the passkey instead of a password. */
  async function finishWithFaceId() {
    setError("");
    setBusy(true);
    try {
      const f = await fetchedBox();
      let tied: boolean | null = null;
      const { address } = await restoreWithFaceId(f.box, async (signer) => {
        tied = await tieAfterRestore(f, signer);
      });
      markBackedUp(address, typedEmail, tied);
      setDoneText(`This is ${shortAddress(address)}, backed up with ${maskEmail(typedEmail)}.`);
      setStep("done");
      onDone?.();
    } catch (e) {
      setError(readable(e));
    } finally {
      setBusy(false);
    }
  }

  /** "Open it": the password of the account this email backs up. */
  async function openOther() {
    if (!conflict || !account) return;
    setError("");
    setBusy(true);
    try {
      const opened = await boxOpensTo(conflict.box, otherPassword);
      if (!opened) {
        setError(WRONG_BACKUP_PASSWORD);
        return;
      }
      const plan = conflictPlan(opened, account.address, conflict.unbound);
      if (plan.kind === "bind-own") {
        if (!conflict.ticket) {
          setError(TIED_ELSEWHERE);
          return;
        }
        await bindOwn(conflict.ticket);
        return;
      }
      setConflict({ ...conflict, plan, other: { address: opened, password: otherPassword } });
    } catch (e) {
      if (!onTicketRefused(e)) setError(readable(e));
    } finally {
      setBusy(false);
    }
  }

  /** "Bring that account here": beside this one, nothing wiped, nothing switched. */
  async function bringOther() {
    if (!conflict?.other) return;
    setError("");
    setBusy(true);
    try {
      const f = { box: conflict.box, bound: !conflict.unbound, ticket: conflict.ticket };
      let tied: boolean | null = null;
      const r = await addRestoredAccount(conflict.box, conflict.other.password, async (signer) => {
        tied = await tieAfterRestore(f, signer);
      });
      markBackedUp(r.address, typedEmail, tied);
      setAdded(r);
      setDoneText(`This is ${shortAddress(r.address)}, backed up with ${maskEmail(typedEmail)}.`);
      setDoneLine(`This account (${short}) still needs a backup with another email.`);
      setConflict(null);
      setStep("done");
    } catch (e) {
      setError(readable(e));
    } finally {
      setBusy(false);
    }
  }

  /** "Replace it": only a row tied to no account, only after typing the word (contract 5.4). */
  async function replaceIt() {
    if (!conflict?.ticket || !conflict.unbound) return;
    setError("");
    setBusy(true);
    try {
      const stored = await storeThroughWallet({ ticket: conflict.ticket, replace: true });
      setConflict(null);
      finishSecure(stored, true);
    } catch (e) {
      if (!onTicketRefused(e)) setError(readable(e));
    } finally {
      setBusy(false);
    }
  }

  const emailHint = <p className="text-xs text-ink-soft">{EMAIL_HINT}</p>;

  if (step === "done") {
    const onThisAccount = added && account && added.address === account.address;
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium text-money">{doneText}</p>
        {doneLine && <p className="text-xs text-ink-soft">{doneLine}</p>}
        {added && !onThisAccount && (
          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                void switchAccount(added.address).catch((e) => {
                  setError((e as Error).message);
                  setBusy(false);
                });
              }}
              className="rounded-full border border-money bg-money px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Use it now
            </button>
            {/* In the backup flow the account in use still has no backup: the other way on is
                another email for it (contract 5.4). In the add flow it is simply "Not now". */}
            <button
              type="button"
              disabled={busy}
              onClick={() => (secure ? chooseAnotherEmail() : onDone?.())}
              className="rounded-full border border-line px-4 py-2 text-sm font-medium text-ink"
            >
              {secure ? "Use another email" : "Not now"}
            </button>
          </div>
        )}
        {added && onThisAccount && <p className="text-xs text-ink-soft">It&apos;s the account you&apos;re using now.</p>}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    );
  }

  if (step === "conflict" && conflict) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold text-ink">This email already backs up another Lumenia account.</p>
        <p className="text-sm text-ink-soft">
          {conflict.unbound
            ? "It holds an older backup that isn't tied to any account yet. Open it with its password, use another email, or replace it."
            : "One email backs up one account. Bring that account here, or use another email for this one."}
        </p>
        {conflict.plan.kind === "offer-bring" && conflict.other ? (
          <>
            <p className="text-sm text-ink-soft">
              That backup opens {shortAddress(conflict.other.address)}. This account ({short}) still needs a backup with
              another email.
            </p>
            {error && <p className="text-sm text-danger">{error}</p>}
            <PrimaryButton loading={busy} loadingLabel="Bringing it here..." onClick={bringOther}>
              Bring that account here
            </PrimaryButton>
            <button type="button" className={quiet} disabled={busy} onClick={() => chooseAnotherEmail()}>
              Use another email
            </button>
          </>
        ) : (
          <>
            <label className="text-sm text-ink-soft">
              Enter the password of the account this email backs up.
              <input
                type="password"
                autoComplete="off"
                value={otherPassword}
                onChange={(e) => setOtherPassword(e.target.value)}
                className={`${field} mt-1`}
              />
            </label>
            {error && <p className="text-sm text-danger">{error}</p>}
            <PrimaryButton loading={busy && !replacing} loadingLabel="Opening..." disabled={otherPassword.length < 1 || busy} onClick={openOther}>
              Open it
            </PrimaryButton>
            <button type="button" className={quiet} disabled={busy} onClick={() => chooseAnotherEmail()}>
              Use another email
            </button>
            {conflict.plan.kind === "ask-password" && conflict.plan.offerReplace && conflict.ticket && (
              <div className="mt-1 border-t border-line pt-3">
                {replacing ? (
                  <>
                    <label className="text-sm text-ink-soft">
                      Replacing it means that backup no longer opens with this email. Type {REPLACE_WORD} to confirm.
                      <input
                        value={replaceTyped}
                        onChange={(e) => setReplaceTyped(e.target.value)}
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        className={`${field} mt-1`}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || replaceTyped.trim().toUpperCase() !== REPLACE_WORD}
                      onClick={replaceIt}
                      className="mt-2 rounded-[14px] border border-danger px-3 py-2 text-sm font-medium text-danger disabled:opacity-40"
                    >
                      {busy ? "Replacing..." : "Replace it"}
                    </button>
                  </>
                ) : (
                  <button type="button" className="text-sm text-ink-soft underline-offset-2 hover:underline" onClick={() => setReplacing(true)}>
                    Replace it
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {step === "start" ? (
        <>
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            aria-label="Your email"
            placeholder="Your email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={field}
          />
          {emailHint}
          {error && <p className="text-sm text-danger">{error}</p>}
          <PrimaryButton loading={busy} loadingLabel="Sending…" onClick={sendCode} disabled={!emailOk}>
            Send me a code
          </PrimaryButton>
        </>
      ) : (
        <>
          <p className="text-xs text-ink-soft">
            We sent a 6-digit code to {typedEmail}.{" "}
            <button type="button" className="text-money underline-offset-2 hover:underline" onClick={() => chooseAnotherEmail(true)} disabled={busy}>
              Use a different email
            </button>
          </p>
          {/* The line that was missing. Without it, someone whose account was locked weeks ago sees
              a password box on a page about backing up and reasonably assumes they are picking one
              now. They are not — this account already has a password, and only that one opens it. */}
          {alreadyLocked ? (
            <p className="text-xs text-ink-soft">
              This account already has a password. Enter <strong className="text-ink">that</strong> one
              — it&apos;s the only thing that can open your money
              {rekey ? ", and the only thing that can replace it." : ", so we can't change it here."}
            </p>
          ) : null}
          <input
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="6-digit code"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            className={field}
          />
          <input
            type="password"
            autoComplete={settingNew ? "new-password" : "current-password"}
            aria-label={settingNew ? "Choose a password" : "Your password"}
            placeholder={settingNew ? "Choose a password" : "Your password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={field}
          />
          {rekey && (
            <>
              <p className="text-xs text-ink-soft">
                That password is too easy to be the only key to your money once a sealed copy of it
                is stored. Choose a stronger one — it replaces the old one on this phone too.
              </p>
              <input
                type="password"
                autoComplete="new-password"
                aria-label="Choose a stronger password"
                placeholder="Choose a stronger password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={field}
              />
            </>
          )}
          {/* Typed once, in a field that shows nothing back, for a password that cannot be reset. */}
          {choosing && (
            <input
              type="password"
              autoComplete="new-password"
              aria-label="Type the password again"
              placeholder="Type it again"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={field}
            />
          )}
          {secure && (
            <>
              {choosing && chosen && !chosenCheck.ok && chosenCheck.reason && (
                <p className="text-xs text-danger">{chosenCheck.reason}</p>
              )}
              {choosing && chosenCheck.ok && confirm && !matches && (
                <p className="text-xs text-danger">Those two don&apos;t match.</p>
              )}
              <p className="text-xs text-ink-soft">
                Remember it, because it can&apos;t be reset. It is the only key to your money.
              </p>
              {faceCapable && (
                <label className="flex items-center gap-2 text-sm text-ink">
                  <input
                    type="checkbox"
                    checked={addFaceId}
                    onChange={(e) => setAddFaceId(e.target.checked)}
                    className="size-4 accent-money"
                  />
                  Also unlock with Face ID on this phone
                </label>
              )}
            </>
          )}
          {!secure && <p className="text-xs text-ink-soft">This is the password you chose when you backed up {typedEmail}.</p>}
          {error && <p className="text-sm text-danger">{error}</p>}
          <PrimaryButton loading={busy} loadingLabel="Working…" onClick={finish} disabled={!codeOk || !pwOk}>
            {secure ? "Back up my money" : adding ? "Bring it here" : "Restore my money"}
          </PrimaryButton>
          {mode === "restore" && faceCapable && (
            <button
              type="button"
              onClick={finishWithFaceId}
              disabled={busy || !codeOk}
              className="text-sm font-semibold text-money underline-offset-2 hover:underline disabled:opacity-50"
            >
              Or restore with Face ID
            </button>
          )}
          <button
            type="button"
            onClick={sendCode}
            disabled={busy}
            className="text-xs text-ink-soft underline-offset-2 hover:underline"
          >
            Resend the code
          </button>
        </>
      )}
    </div>
  );
}
