/**
 * Restore an account from its backup, in three steps: email -> one-time code -> password.
 *
 * The step is the WORKER's (state.restore), not the popup's: closing the popup in the middle of a
 * restore and opening it again lands on the same step. Only "I pressed Restore on Connect and have
 * not asked for a code yet" lives in the shell.
 *
 * The same steps bring another account in place of the one held here ("Use another account" in
 * Settings, `switching`): the account held now must be confirmed backed up first, and its links show
 * again when it is brought back.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { URLS } from "../../config";
import { EMAIL_HINT } from "../../lib/copy";
import type { ErrorCode } from "../../lib/types";
import { ask } from "../api";
import { useApp } from "../context";
import { useEscape } from "../escape";
import { maskEmail, plainSentence, shortAddress } from "../format";
import { useAlive, useCountdown } from "../hooks";
import { IconBack } from "../icons";
import { BrandBar, Button, ExtLink, Heading, Mascot, Notice, Progress, SubBar, TextField } from "../ui";

interface RestoreProblem {
  text: string;
  /** a link to Settings on the website, with the words to put on it */
  settings?: string;
}

/** Each way a restore step can be refused, in words a person can act on. */
function restoreProblem(code: ErrorCode, message: string): RestoreProblem {
  switch (code) {
    case "bad-email":
      return { text: "That doesn't look like an email address." };
    case "bad-code":
      return { text: "That code is wrong or has expired." };
    case "no-backup":
      return { text: "We couldn't find a backup for that email.", settings: "Make a backup on your account page on getlumenia.com" };
    case "no-password-copy":
      return { text: "That backup opens with a passkey on getlumenia.com only.", settings: "Add a password backup on your account page on getlumenia.com" };
    case "bad-password":
      return { text: "That password doesn't open this backup." };
    case "unsupported-backup":
      return { text: plainSentence(message) ?? "This backup can't be opened in the extension." };
    case "rate-limited":
      return { text: "Too many tries. Wait a few minutes, then try again." };
    case "offline":
      return { text: "We couldn't reach Lumenia. Check your connection and try again." };
    case "needs-backup":
    case "busy":
      return { text: plainSentence(message) ?? "Back this account up first. It lives only in this browser." };
    default:
      return { text: plainSentence(message) ?? "Something went wrong. Try again." };
  }
}

function Problem({ id, problem }: { id: string; problem: RestoreProblem }) {
  return (
    <Notice tone="error" id={id}>
      <span>{problem.text}</span>
      {problem.settings ? (
        <>
          {" "}
          <ExtLink href={URLS.backup}>{problem.settings}</ExtLink>
        </>
      ) : null}
    </Notice>
  );
}

function BackLink({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button type="button" class="back-link" onClick={onClick}>
      <IconBack />
      {children}
    </button>
  );
}

/**
 * The header of the code and password steps while another account is being brought in (Use another
 * account): back to Settings, which ends that restore. The account held here is untouched until the
 * password step has opened the other one.
 */
function SwitchBar() {
  const { refresh, go } = useApp();
  return (
    <SubBar
      title="Use another account"
      onBack={() => {
        void ask("restore.cancel").then(() => {
          go("settings");
          return refresh();
        });
      }}
    />
  );
}

/* --------------------------------- step 1: email --------------------------------- */

export function RestoreEmail({ switching = false }: { switching?: boolean }) {
  const { ws, refresh, leaveRestore, go } = useApp();
  const alive = useAlive();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<RestoreProblem | null>(null);
  const leave = () => (switching ? go("settings") : leaveRestore());
  useEscape(() => {
    leave();
    return true;
  });

  async function submit(e: Event) {
    e.preventDefault();
    const value = email.trim();
    if (!value || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await ask("restore.requestCode", { email: value, ...(switching ? { switching: true as const } : {}) });
    if (!alive.current) return;
    if (!r.ok) {
      setBusy(false);
      setProblem(restoreProblem(r.code, r.message));
      return;
    }
    await refresh(); // the worker now holds the step: the code screen takes over
    if (alive.current) setBusy(false);
  }

  const held = ws.account;
  return (
    <>
      {switching ? <SubBar title="Use another account" onBack={leave} /> : <BrandBar />}
      <main class="screen">
        {switching ? null : <BackLink onClick={leaveRestore}>Back</BackLink>}
        <div class="beat beat--row">
          <Mascot pose="phone" size="sm" />
          <div class="beat__text">
            <Heading focus={false}>{switching ? "Bring another account here" : "Bring your account here"}</Heading>
            <p class="lede">Enter the email of your backup. We'll send you a <span class="nowrap">6-digit</span> code.</p>
          </div>
        </div>
        {switching && held ? (
          <p class="fine">
            This account ({shortAddress(held.pubkey)}) stays backed up{held.email ? ` with ${maskEmail(held.email)}` : ""}. Its links show again when you bring it back.
          </p>
        ) : null}
        <form class="stack" onSubmit={submit} noValidate>
          <TextField
            id="email"
            label="Email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onValue={setEmail}
            readOnly={busy}
            invalid={Boolean(problem)}
            describedBy={problem ? "email-problem" : "email-hint"}
            autoFocus
          />
          {problem ? (
            <Problem id="email-problem" problem={problem} />
          ) : (
            <p class="fine" id="email-hint">
              {EMAIL_HINT}
            </p>
          )}
          <Button type="submit" busy={busy} busyLabel="Sending the code" disabled={!email.trim()}>
            Send me a code
          </Button>
        </form>
      </main>
    </>
  );
}

/* --------------------------------- step 2: code --------------------------------- */

const RESEND_AFTER_MS = 30_000;

export function RestoreCode() {
  const { ws, refresh, startRestore, go } = useApp();
  const alive = useAlive();
  const step = ws.restore!;
  const wait = useCountdown(step.codeSentAt + RESEND_AFTER_MS);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [problem, setProblem] = useState<RestoreProblem | null>(null);
  const [note, setNote] = useState("");
  const otpRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    otpRef.current?.focus();
  }, []);

  async function submit(value: string) {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setProblem(null);
    const r = await ask("restore.submitCode", { code: value });
    if (!alive.current) return;
    if (!r.ok) {
      setBusy(false);
      setProblem(restoreProblem(r.code, r.message));
      return;
    }
    await refresh(); // the password step takes over
    if (alive.current) setBusy(false);
  }

  function onCode(el: HTMLInputElement) {
    const digits = el.value.replace(/\D/g, "").slice(0, 6);
    el.value = digits; // keep the box honest even when the state does not change
    setCode(digits);
    setProblem(null);
    if (digits.length === 6) void submit(digits);
  }

  async function resend() {
    setResending(true);
    setProblem(null);
    setNote("");
    const r = await ask("restore.requestCode", { email: step.email, ...(step.switching ? { switching: true as const } : {}) });
    if (!alive.current) return;
    setResending(false);
    if (!r.ok) {
      setProblem(restoreProblem(r.code, r.message));
      return;
    }
    setCode("");
    setNote("A new code is on its way.");
    await refresh();
  }

  async function otherEmail() {
    await ask("restore.cancel");
    if (step.switching) go("switch");
    else startRestore();
    await refresh();
  }

  return (
    <>
      {step.switching ? <SwitchBar /> : <BrandBar />}
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
            <label class="field__label" for="otp">
              6-digit code
            </label>
            <div class={problem ? "field__box is-invalid" : "field__box"}>
              <input
                id="otp"
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
                aria-describedby={problem ? "otp-problem" : undefined}
                ref={otpRef}
                onInput={(e) => onCode(e.currentTarget)}
              />
            </div>
          </div>
          {problem ? <Problem id="otp-problem" problem={problem} /> : null}
          {note && !problem ? <Notice>{note}</Notice> : null}
          <Button type="submit" busy={busy} busyLabel="Checking the code" disabled={code.length !== 6}>
            Continue
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
    </>
  );
}

/* --------------------------------- step 3: password --------------------------------- */

export function RestorePassword() {
  const { ws, refresh, startRestore, go, justRestored } = useApp();
  const alive = useAlive();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<RestoreProblem | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setProblem(null);
    const r = await ask("restore.submitPassword", { password });
    if (!alive.current) return;
    if (!r.ok) {
      setBusy(false);
      setProblem(restoreProblem(r.code, r.message));
      return;
    }
    setPassword("");
    justRestored(r.data); // named once on the next screen: "This is ..., backed up with ..."
    go("home");
    await refresh(); // the account is here: the home screen takes over
    if (alive.current) setBusy(false);
  }

  async function startOver() {
    const switching = ws.restore?.switching === true;
    await ask("restore.cancel");
    if (switching) go("switch");
    else startRestore();
    await refresh();
  }

  return (
    <>
      {ws.restore?.switching ? <SwitchBar /> : <BrandBar />}
      <main class="screen">
        <Heading focus={false}>Enter your backup password</Heading>
        <p class="lede">
          This is the password you chose when you backed up <strong class="break">{ws.restore?.email}</strong>.
        </p>
        <form class="stack" onSubmit={submit}>
          <TextField
            id="backup-password"
            label="Backup password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onValue={setPassword}
            readOnly={busy}
            invalid={Boolean(problem)}
            describedBy={problem ? "pw-problem" : busy ? "pw-progress" : undefined}
            autoFocus
            trailing={
              <button type="button" class="field__toggle" onClick={() => setShow((s) => !s)} aria-pressed={show} disabled={busy}>
                {show ? "Hide" : "Show"}
              </button>
            }
          />
          {problem ? <Problem id="pw-problem" problem={problem} /> : null}
          {busy ? (
            <div class="progress-note" id="pw-progress">
              <p class="fine">Opening your backup. This takes a few seconds.</p>
              <Progress label="Opening your backup" />
            </div>
          ) : null}
          <Button type="submit" busy={busy} busyLabel="Opening your backup" disabled={!password}>
            Restore
          </Button>
        </form>
        <div class="row row--center">
          <Button variant="quiet" small onClick={startOver} disabled={busy}>
            Start over
          </Button>
        </div>
      </main>
    </>
  );
}
