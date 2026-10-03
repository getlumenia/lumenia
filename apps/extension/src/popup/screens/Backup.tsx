/**
 * Back up an account that was made here: an email, then the code mailed to it. The account's
 * password copy (wrapped when the account was made, ciphertext only) is stored on Lumenia's server,
 * so this account can be restored on any device, in this extension or on getlumenia.com, with that
 * email and the account password. Nothing is decrypted here and the password is not asked again.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { ask } from "../api";
import { useApp } from "../context";
import { plainSentence } from "../format";
import { useAlive, useCountdown } from "../hooks";
import { Button, Heading, Mascot, Notice, TextField } from "../ui";

const RESEND_AFTER_MS = 30_000;

export function Backup() {
  const { ws, go } = useApp();
  const [done, setDone] = useState(false);
  if (done || !ws.backup.needed) {
    return (
      <main class="screen screen--beat">
        <Mascot pose="thumbsup" size="lg" label />
        <Heading class="h1--center">{done ? "Backed up" : "Already backed up"}</Heading>
        <p class="lede lede--center">
          If this browser is ever lost, restore your account on any device with your email and your password.
        </p>
        <div class="screen__spacer" />
        <Button onClick={() => go("home")}>Done</Button>
      </main>
    );
  }
  return ws.backup.step === "code" ? <BackupCode onDone={() => setDone(true)} /> : <BackupEmail />;
}

function problemText(code: string, message: string): string {
  if (code === "bad-email") return "That doesn't look like an email address.";
  if (code === "bad-code") return "That code is wrong or has expired.";
  if (code === "locked") return "Unlock first, then try again.";
  return plainSentence(message) ?? "We couldn't back it up just now. Try again.";
}

function BackupEmail() {
  const { refresh } = useApp();
  const alive = useAlive();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

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
          <Heading focus={false}>Keep it safe</Heading>
          <p class="lede">Back up your account with your email. We'll send you a <span class="nowrap">6-digit</span> code.</p>
        </div>
      </div>
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
          describedBy={problem ? "backup-problem" : "backup-hint"}
          autoFocus
        />
        {problem ? (
          <Notice tone="error" id="backup-problem">
            {problem}
          </Notice>
        ) : (
          <p class="fine" id="backup-hint">
            Your backup is locked with your password. We can't open it, and nobody with only your email can either.
          </p>
        )}
        <Button type="submit" busy={busy} busyLabel="Sending the code" disabled={!email.trim()}>
          Send me a code
        </Button>
      </form>
    </main>
  );
}

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
