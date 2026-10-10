/**
 * Back up an account: an email, then the code mailed to it. The account's password copy (wrapped
 * when the account was made, or again for a new email, ciphertext only) is stored on Lumenia's
 * server, so this account can be restored on any device, in this extension or on getlumenia.com,
 * with that email and the account password. Nothing is decrypted here.
 *
 * One email backs up one account (LUMENIA ACCOUNT CONTRACT v1, 5.4). When the code shows the email
 * already backs up ANOTHER account, nothing is stored: the person brings that account here, uses
 * another email, or, only for a backup tied to no account yet, replaces it on purpose.
 *
 * The same steps change an account's backup email (`again`): its password wraps a new copy first,
 * and once the new email holds it, the old email stops opening the account.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { URLS } from "../../config";
import { EMAIL_HINT } from "../../lib/copy";
import type { BackupRecord, ErrorCode } from "../../lib/types";
import { ask } from "../api";
import { useApp } from "../context";
import { accountLine, maskEmail, plainSentence, shortAddress } from "../format";
import { useAlive, useCountdown } from "../hooks";
import { Button, ExtLink, Heading, Mascot, Notice, TextField } from "../ui";

const RESEND_AFTER_MS = 30_000;

/** "That took too long": a conflict's ticket is good for ten minutes and one use. */
const TICKET_EXPIRED = "That took too long. Send a new code and try again.";

type Done = { own: boolean };

export function Backup({ again = false }: { again?: boolean }) {
  const { ws } = useApp();
  const [done, setDone] = useState<Done | null>(null);
  const b = ws.backup;
  if (done) return <BackedUp own={done.own} />;
  if (b.conflict) return <Conflict onDone={setDone} />;
  if (b.step === "code") return <BackupCode onDone={() => setDone({ own: false })} />;
  if (again) return b.again ? <BackupEmail again /> : <AgainPassword />;
  if (!b.needed) return <BackedUp own={false} already />;
  return <BackupEmail />;
}

/** The account is backed up: what that means, and where it opens. */
function BackedUp({ own, already = false }: { own: boolean; already?: boolean }) {
  const { ws, go } = useApp();
  const short = shortAddress(ws.account?.pubkey ?? "");
  return (
    <main class="screen screen--beat">
      <Mascot pose="thumbsup" size="lg" label />
      <Heading class="h1--center">{already ? "Already backed up" : "Backed up"}</Heading>
      {own ? (
        <p class="lede lede--center">Backed up. This email now opens this account ({short}).</p>
      ) : (
        <p class="lede lede--center">If this browser is ever lost, restore your account on any device with your email and your password.</p>
      )}
      {ws.account && !own ? <p class="fine fine--center">{accountLine(ws.account, ws.backup.needed).text}.</p> : null}
      <p class="fine fine--center">
        It opens on your phone too, with your email and your password: <ExtLink href={URLS.start}>getlumenia.com</ExtLink>.
      </p>
      <div class="screen__spacer" />
      <Button onClick={() => go("home")}>Done</Button>
    </main>
  );
}

function problemText(code: ErrorCode | string, message: string): string {
  if (code === "bad-email") return "That doesn't look like an email address.";
  if (code === "bad-code") return plainSentence(message) === TICKET_EXPIRED ? TICKET_EXPIRED : "That code is wrong or has expired.";
  if (code === "bad-password") return "That password doesn't open this backup.";
  if (code === "locked") return "Unlock first, then try again.";
  return plainSentence(message) ?? "We couldn't back it up just now. Try again.";
}

/* ------------------------------- Change backup email: the password ------------------------------- */

/** The account's password wraps a new backup copy, for the email the person gives next. */
function AgainPassword() {
  const { ws, refresh } = useApp();
  const alive = useAlive();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const acct = ws.account;

  async function submit(e: Event) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setProblem("");
    const r = await ask("backup.again", { password });
    if (!alive.current) return;
    if (!r.ok) {
      setBusy(false);
      setProblem(r.code === "bad-password" ? "That password doesn't unlock this account." : problemText(r.code, r.message));
      return;
    }
    setPassword("");
    await refresh(); // the email step takes over
    if (alive.current) setBusy(false);
  }

  return (
    <main class="screen">
      <Heading focus={false}>Enter your password</Heading>
      <p class="lede">
        The new backup is locked with this account's password, the same way it is locked here. We can't open it, and nobody with only
        your email can either.
      </p>
      {acct ? <p class="fine">{accountLine(acct, ws.backup.needed).text}.</p> : null}
      <form class="stack" onSubmit={submit}>
        <TextField
          id="again-password"
          label="Password"
          type={show ? "text" : "password"}
          autoComplete="current-password"
          value={password}
          onValue={setPassword}
          readOnly={busy}
          invalid={Boolean(problem)}
          describedBy={problem ? "again-problem" : undefined}
          autoFocus
          trailing={
            <button type="button" class="field__toggle" onClick={() => setShow((s) => !s)} aria-pressed={show} disabled={busy}>
              {show ? "Hide" : "Show"}
            </button>
          }
        />
        {problem ? (
          <Notice tone="error" id="again-problem">
            {problem}
          </Notice>
        ) : null}
        <Button type="submit" busy={busy} busyLabel="Unlocking" disabled={!password}>
          Continue
        </Button>
      </form>
    </main>
  );
}

/* ----------------------------------- the email ----------------------------------- */

function BackupEmail({ again = false }: { again?: boolean }) {
  const { ws, refresh } = useApp();
  const alive = useAlive();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const acct = ws.account;

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setProblem("");
    const r = await ask("backup.requestCode", { email: email.trim() });
    if (!alive.current) return;
    if (!r.ok) {
      setBusy(false);
      setProblem(problemText(r.code, r.message));
      return;
    }
    await refresh(); // the code step takes over
    if (alive.current) setBusy(false);
  }

  return (
    <main class="screen">
      <div class="beat beat--row">
        <Mascot pose="messenger" size="sm" />
        <div class="beat__text">
          <Heading focus={false}>{again ? "Pick the new email" : "Keep it safe"}</Heading>
          <p class="lede">
            {again ? "Back up this account with another email." : "Back up your account with your email."} We'll send you a{" "}
            <span class="nowrap">6-digit</span> code.
          </p>
        </div>
      </div>
      {again && acct?.email ? (
        <p class="fine">
          This account ({shortAddress(acct.pubkey)}) is backed up with {maskEmail(acct.email)} now. The new email takes its place.
        </p>
      ) : null}
      <form class="stack" onSubmit={submit} noValidate>
        <TextField
          id="backup-email"
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onValue={setEmail}
          readOnly={busy}
          invalid={Boolean(problem)}
          describedBy={problem ? "backup-problem" : "backup-hint backup-hint-2"}
          autoFocus
        />
        {problem ? (
          <Notice tone="error" id="backup-problem">
            {problem}
          </Notice>
        ) : (
          <>
            <p class="fine" id="backup-hint">
              {EMAIL_HINT}
            </p>
            <p class="fine" id="backup-hint-2">
              Your backup is locked with your password. We can't open it, and nobody with only your email can either.
            </p>
          </>
        )}
        <Button type="submit" busy={busy} busyLabel="Sending the code" disabled={!email.trim()}>
          Send me a code
        </Button>
      </form>
    </main>
  );
}

/* ----------------------------------- the code ----------------------------------- */

function BackupCode({ onDone }: { onDone: () => void }) {
  const { ws, refresh } = useApp();
  const alive = useAlive();
  const step = ws.backup;
  const wait = useCountdown((step.codeSentAt ?? 0) + RESEND_AFTER_MS);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const otpRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    otpRef.current?.focus();
  }, []);

  async function submit(value: string) {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setProblem("");
    const r = await ask("backup.submitCode", { code: value });
    if (!alive.current) return;
    if (!r.ok) {
      if (r.code === "email-taken") {
        // The email backs up another account: the worker kept that, and the choice screen takes over.
        await refresh();
        if (alive.current) setBusy(false);
        return;
      }
      setBusy(false);
      setProblem(problemText(r.code, r.message));
      return;
    }
    onDone();
    await refresh();
    if (alive.current) setBusy(false);
  }

  function onCode(el: HTMLInputElement) {
    const digits = el.value.replace(/\D/g, "").slice(0, 6);
    el.value = digits;
    setCode(digits);
    setProblem("");
    if (digits.length === 6) void submit(digits);
  }

  async function resend() {
    setResending(true);
    setProblem("");
    setNote("");
    const r = await ask("backup.requestCode", { email: step.email });
    if (!alive.current) return;
    setResending(false);
    if (!r.ok) {
      setProblem(problemText(r.code, r.message));
      return;
    }
    setCode("");
    setNote("A new code is on its way.");
    await refresh();
  }

  async function otherEmail() {
    await ask("backup.cancel");
    await refresh();
  }

  return (
    <main class="screen">
      <Heading focus={false}>Check your email</Heading>
      <p class="lede">
        We sent a <span class="nowrap">6-digit</span> code to <strong class="break">{step.email}</strong>. It can take a minute to arrive.
      </p>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(code);
        }}
      >
        <div class="field">
          <label class="field__label" for="backup-otp">
            6-digit code
          </label>
          <div class={problem ? "field__box is-invalid" : "field__box"}>
            <input
              id="backup-otp"
              class="field__input field__input--code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              value={code}
              readOnly={busy}
              spellcheck={false}
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? "backup-otp-problem" : undefined}
              ref={otpRef}
              onInput={(e) => onCode(e.currentTarget)}
            />
          </div>
        </div>
        {problem ? (
          <Notice tone="error" id="backup-otp-problem">
            {problem}
          </Notice>
        ) : null}
        {note && !problem ? <Notice>{note}</Notice> : null}
        <Button type="submit" busy={busy} busyLabel="Backing it up" disabled={code.length !== 6}>
          Back it up
        </Button>
      </form>
      <div class="row row--center">
        <Button variant="quiet" small onClick={resend} busy={resending} busyLabel="Sending" disabled={wait > 0}>
          {wait > 0 ? `Send a new code (${wait} s)` : "Send a new code"}
        </Button>
        <Button variant="quiet" small onClick={otherEmail} disabled={busy}>
          Use a different email
        </Button>
      </div>
    </main>
  );
}

/* ------------------------- the email already backs up another account ------------------------- */

/**
 * The choice of LUMENIA ACCOUNT CONTRACT v1, 5.4, shown only after the code proved the inbox is the
 * person's own. "Bring that account here" opens that backup with its password; when it opens to this
 * very account (its own older backup, tied to no account yet) the email is tied to it, and when it
 * opens to another account, this one leaves the browser for it (said first, and refused by the worker
 * until the person says so). "Replace it" exists only for a backup tied to no account yet.
 */
function Conflict({ onDone }: { onDone: (d: Done) => void }) {
  const { ws, refresh, go, justRestored } = useApp();
  const alive = useAlive();
  const c = ws.backup.conflict!;
  const acct = ws.account;
  const short = shortAddress(acct?.pubkey ?? "");
  const [mode, setMode] = useState<"choose" | "password" | "replace" | "lose">("choose");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [expired, setExpired] = useState(false);
  /** what the worker said this account loses by leaving (links still open, an unconfirmed backup) */
  const [loss, setLoss] = useState("");
  const [openNote, setOpenNote] = useState("");
  /** this browser's account is confirmed backed up: it can leave and come back, links and all */
  const confirmed = acct?.bound === true && !ws.backup.needed;

  const fail = (code: ErrorCode, message: string) => {
    if (code === "bad-code") {
      setExpired(true);
      setProblem(TICKET_EXPIRED);
      return;
    }
    setProblem(problemText(code, message));
  };

  async function useAnother() {
    await ask("backup.cancel");
    await refresh();
  }

  async function newCode() {
    setBusy(true);
    const r = await ask("backup.requestCode", { email: c.email });
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) {
      setProblem(problemText(r.code, r.message));
      return;
    }
    await refresh(); // the code step takes over
  }

  async function open(opts: { loseAccount?: true; leaveOpenLinks?: true } = {}) {
    if (!password || busy) return;
    setBusy(true);
    setProblem("");
    const r = await ask("backup.useExisting", { password, ...opts });
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) {
      setPassword("");
      if (r.data.same) {
        onDone({ own: true });
        await refresh();
        return;
      }
      justRestored({ pubkey: r.data.pubkey, email: c.email, bound: r.data.bound, same: false });
      go("home");
      await refresh();
      return;
    }
    if (r.code === "not-backed-up") {
      // Opened to another account, and this one was never (or not surely) backed up: say what goes.
      setLoss(plainSentence(r.message) ?? "");
      setMode("lose");
      await refresh(); // the worker kept which account it opened to
      return;
    }
    if (r.code === "open-links") {
      setOpenNote(plainSentence(r.message) ?? r.message);
      return;
    }
    fail(r.code, r.message);
  }

  async function replace() {
    if (typed.trim() !== "REPLACE" || busy) return;
    setBusy(true);
    setProblem("");
    const r = await ask("backup.replace", { confirm: "REPLACE" });
    if (!alive.current) return;
    setBusy(false);
    if (r.ok) {
      onDone({ own: false });
      await refresh();
      return;
    }
    fail(r.code, r.message);
  }

  const other = c.other ? shortAddress(c.other) : "that account";

  return (
    <main class="screen">
      <Heading focus={false}>This email already backs up another Lumenia account.</Heading>
      <p class="lede">
        {c.unbound
          ? "It holds an older backup that isn't tied to any account yet. Open it with its password, use another email, or replace it."
          : "One email backs up one account. Bring that account here, or use another email for this one."}
      </p>
      <p class="fine">
        <strong class="break">{c.email}</strong>
      </p>

      {expired ? (
        <>
          <Notice tone="error">{TICKET_EXPIRED}</Notice>
          <Button onClick={newCode} busy={busy} busyLabel="Sending the code">
            Send a new code
          </Button>
          <Button variant="secondary" onClick={useAnother} disabled={busy}>
            Use another email
          </Button>
        </>
      ) : mode === "choose" ? (
        <div class="stack">
          <Button onClick={() => setMode("password")}>Bring that account here</Button>
          <Button variant="secondary" onClick={useAnother}>
            Use another email
          </Button>
          {c.unbound && c.ticket ? (
            <Button variant="quiet" class="btn--danger-text" onClick={() => setMode("replace")}>
              Replace it
            </Button>
          ) : null}
        </div>
      ) : mode === "password" ? (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void open();
          }}
        >
          {confirmed && acct?.email ? (
            <p class="fine">
              This account ({short}) stays backed up with {maskEmail(acct.email)}. Its links show again when you bring it back.
            </p>
          ) : null}
          <TextField
            id="conflict-password"
            label="Enter the password of the account this email backs up."
            type={show ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onValue={setPassword}
            readOnly={busy}
            invalid={Boolean(problem)}
            describedBy={problem ? "conflict-problem" : undefined}
            autoFocus
            trailing={
              <button type="button" class="field__toggle" onClick={() => setShow((s) => !s)} aria-pressed={show} disabled={busy}>
                {show ? "Hide" : "Show"}
              </button>
            }
          />
          {problem ? (
            <Notice tone="error" id="conflict-problem">
              {problem}
            </Notice>
          ) : null}
          {busy ? <p class="fine">Opening the backup. This takes a few seconds.</p> : null}
          <Button type="submit" busy={busy} busyLabel="Opening it" disabled={!password}>
            Open it
          </Button>
          <Button variant="secondary" onClick={useAnother} disabled={busy}>
            Use another email
          </Button>
        </form>
      ) : mode === "lose" ? (
        <div class="stack">
          <Notice>
            {ws.backup.needed
              ? `This browser's account (${short}) was never backed up. It holds only practice money, and it will be removed from this browser.`
              : loss || `This browser's account (${short}) will be removed from this browser.`}
          </Notice>
          {openNote ? <p class="confirm__text">{openNote}</p> : null}
          {problem ? <Notice tone="error">{problem}</Notice> : null}
          <Button variant="danger" onClick={() => void open({ loseAccount: true, ...(openNote ? { leaveOpenLinks: true as const } : {}) })} busy={busy} busyLabel="Opening it">
            Use {other} here
          </Button>
          <Button variant="secondary" onClick={useAnother} disabled={busy}>
            Use another email
          </Button>
        </div>
      ) : (
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void replace();
          }}
        >
          <TextField
            id="conflict-replace"
            label="Replacing it means that backup no longer opens with this email. Type REPLACE to confirm."
            value={typed}
            onValue={setTyped}
            readOnly={busy}
            invalid={Boolean(problem)}
            describedBy={problem ? "replace-problem" : undefined}
            autoFocus
          />
          {problem ? (
            <Notice tone="error" id="replace-problem">
              {problem}
            </Notice>
          ) : null}
          <Button type="submit" variant="danger" busy={busy} busyLabel="Replacing it" disabled={typed.trim() !== "REPLACE"}>
            Replace it
          </Button>
          <Button variant="secondary" onClick={() => setMode("choose")} disabled={busy}>
            Back
          </Button>
        </form>
      )}
    </main>
  );
}

/* ------------------------------- Add your backup email ------------------------------- */

/**
 * An account restored by 0.1.3 or earlier, which never kept its backup email: the person types it,
 * and a signed question to Lumenia's server (no code needed) says whether that email backs up THIS
 * account. Only a yes is kept, so the line under the header never names an email that does not.
 */
export function AddEmail() {
  const { ws, refresh, go } = useApp();
  const alive = useAlive();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [done, setDone] = useState<BackupRecord | null>(null);
  const acct = ws.account;
  const short = shortAddress(acct?.pubkey ?? "");

  async function submit(e: Event) {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setProblem("");
    const r = await ask("account.checkBackupEmail", { email: email.trim() });
    if (!alive.current) return;
    setBusy(false);
    if (!r.ok) {
      setProblem(
        r.code === "backup-not-mine"
          ? "That email doesn't back up this account."
          : r.code === "bad-email" || r.code === "locked"
            ? problemText(r.code, r.message)
            : (plainSentence(r.message) ?? "We couldn't check that just now. Try again later."),
      );
      return;
    }
    setDone(r.data);
    await refresh();
  }

  if (done && acct) {
    return (
      <main class="screen screen--beat">
        <Mascot pose="thumbsup" size="lg" label />
        <Heading class="h1--center">Backed up</Heading>
        <p class="lede lede--center">{accountLine({ pubkey: acct.pubkey, email: done.email, bound: done.bound }, false).text}.</p>
        <div class="screen__spacer" />
        <Button onClick={() => go("home")}>Done</Button>
      </main>
    );
  }

  return (
    <main class="screen">
      <Heading focus={false}>Add your backup email</Heading>
      <p class="lede">Enter the email this account ({short}) is backed up with. We check it with Lumenia's server; no code is needed.</p>
      <form class="stack" onSubmit={submit} noValidate>
        <TextField
          id="add-email"
          label="Email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onValue={setEmail}
          readOnly={busy}
          invalid={Boolean(problem)}
          describedBy={problem ? "add-email-problem" : "add-email-hint"}
          autoFocus
        />
        {problem ? (
          <Notice tone="error" id="add-email-problem">
            {problem}
          </Notice>
        ) : (
          <p class="fine" id="add-email-hint">
            {EMAIL_HINT}
          </p>
        )}
        <Button type="submit" busy={busy} busyLabel="Checking" disabled={!email.trim()}>
          Check it
        </Button>
      </form>
    </main>
  );
}
