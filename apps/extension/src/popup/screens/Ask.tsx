/**
 * Ask to join real money, for the account in use: the key this extension holds, never the website's
 * (LUMENIA ACCOUNT CONTRACT v1, 5.2). The email is the one that backs this account up when this
 * browser knows it; the real-money server may ask for a code mailed to it first, to be sure the email
 * is the person's own. An account with no real-money sends left asks for more sends the same way.
 *
 * The worker signs the request and refuses before anything is sent when the account cannot ask
 * (background/pilot-ask.ts); this screen shows what it answered, in the contract's words.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { DISCLOSE_PILOT_ASK } from "../../lib/copy";
import type { ResponseMap } from "../../lib/messages";
import { sendsLeft, standingCopy } from "../../lib/standing";
import type { ErrorCode } from "../../lib/types";
import { ask } from "../api";
import { useApp } from "../context";
import { useStanding } from "../data";
import { askResultCopy, maskEmail, plainSentence, shortAddress } from "../format";
import { useAlive, useCountdown } from "../hooks";
import { Button, Heading, Mascot, Notice, TextField } from "../ui";

const RESEND_AFTER_MS = 30_000;

type Answer = ResponseMap["pilot.request"];

function problemText(code: ErrorCode, message: string): string {
  if (code === "bad-email") return "That doesn't look like an email address.";
  if (code === "bad-code") return "That code is wrong or has expired.";
  if (code === "locked") return "Unlock first, then try again.";
  if (code === "rate-limited") return plainSentence(message) ?? "Too many tries in a minute. Wait a moment, then try again.";
  // The server's own sentence for every refusal it states (an email that backs up another account,
  // a code that is required, a signature it could not check).
  return plainSentence(message) ?? "We couldn't send your request just now. Try again later.";
}

export function Ask() {
  const { ws, go, refresh } = useApp();
  const alive = useAlive();
  const st = useStanding(ws);
  const short = shortAddress(ws.account?.pubkey ?? "");
  const known = ws.account?.email ?? null;
  const more = st.standing === "no-sends";
  const [editing, setEditing] = useState(!known);
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<"form" | "code" | "result">("form");
  const [sentTo, setSentTo] = useState("");
  const [codeSentAt, setCodeSentAt] = useState(0);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [resending, setResending] = useState(false);
  const [problem, setProblem] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const otpRef = useRef<HTMLInputElement>(null);
  const wait = useCountdown(codeSentAt + RESEND_AFTER_MS);

  useEffect(() => {
    if (step === "code") otpRef.current?.focus();
  }, [step]);

  const address = (): string => (editing || !known ? email : known).trim();

  async function mailCode(to: string): Promise<boolean> {
    const c = await ask("pilot.requestCode", { email: to });
    if (!alive.current) return false;
    if (!c.ok) {
      setProblem(problemText(c.code, c.message));
      return false;
    }
    setSentTo(to);
    setCodeSentAt(c.data.codeSentAt);
    return true;
  }

  async function send(withCode?: string): Promise<void> {
    const to = withCode ? sentTo : address();
    if (!to || busy) return;
    setBusy(true);
    setProblem("");
    const r = await ask("pilot.request", { email: to, ...(withCode ? { code: withCode } : {}) });
    if (!alive.current) return;
    if (r.ok) {
      setBusy(false);
      setSentTo(to);
      setAnswer(r.data);
      setStep("result");
      void refresh();
      return;
    }
    if (r.code === "pilot-code-required" && !withCode) {
      // The server wants the email shown to be the person's own: a code goes to it, then the same ask again.
      const mailed = await mailCode(to);
      if (!alive.current) return;
      setBusy(false);
      if (mailed) {
        setCode("");
        setStep("code");
      }
      return;
    }
    setBusy(false);
    setProblem(problemText(r.code, r.message));
  }

  function onCode(el: HTMLInputElement) {
    const digits = el.value.replace(/\D/g, "").slice(0, 6);
    el.value = digits;
    setCode(digits);
    setProblem("");
    if (digits.length === 6) void send(digits);
  }

  async function resend() {
    setResending(true);
    setProblem("");
    await mailCode(sentTo);
    if (alive.current) setResending(false);
  }

  const limit = st.info?.limit ?? 0;
  const left = st.info ? sendsLeft(st.info) : 0;

  /* ----------------------------------- the answer ----------------------------------- */
  if (step === "result" && answer) {
    const c = askResultCopy(answer, { short, masked: maskEmail(sentTo), limit, left });
    return (
      <main class="screen screen--beat" aria-live="polite">
        <Mascot pose="thumbsup" size="md" label />
        <Heading class="h1--center">{c.title}</Heading>
        <p class="lede lede--center">{c.line}</p>
        {answer.emailAlsoFor ? <p class="fine fine--center">This email also asked to join for account {answer.emailAlsoFor}.</p> : null}
        <div class="screen__spacer" />
        <Button onClick={() => go("home")}>Done</Button>
      </main>
    );
  }

  /* -------------------------- a standing that has nothing to ask -------------------------- */
  if (step === "form" && (st.standing === "pending" || st.standing === "declined" || st.standing === "revoked" || st.standing === "approved" || st.standing === "open")) {
    const c = standingCopy(st.standing, { short, limit, left });
    return (
      <main class="screen">
        <Heading>Ask to join real money</Heading>
        <Notice>
          <strong>{c.title}</strong> {c.line}
        </Notice>
        <div class="screen__spacer" />
        {st.standing === "pending" ? (
          <Button variant="secondary" onClick={st.check} busy={st.checking} busyLabel="Checking">
            {c.action}
          </Button>
        ) : null}
        <Button onClick={() => go("home")}>Done</Button>
      </main>
    );
  }

  /* ----------------------------------- the code ----------------------------------- */
  if (step === "code") {
    return (
      <main class="screen">
        <Heading focus={false}>Check your email</Heading>
        <p class="lede">
          We sent a <span class="nowrap">6-digit</span> code to <strong class="break">{sentTo}</strong>. Enter it to confirm this email is yours.
        </p>
        <form
          class="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void send(code);
          }}
        >
          <div class="field">
            <label class="field__label" for="ask-otp">
              6-digit code
            </label>
            <div class={problem ? "field__box is-invalid" : "field__box"}>
              <input
                id="ask-otp"
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
                aria-describedby={problem ? "ask-otp-problem" : undefined}
                ref={otpRef}
                onInput={(e) => onCode(e.currentTarget)}
              />
            </div>
          </div>
          {problem ? (
            <Notice tone="error" id="ask-otp-problem">
              {problem}
            </Notice>
          ) : null}
          <Button type="submit" busy={busy} busyLabel="Asking" disabled={code.length !== 6}>
            {more ? "Ask for more sends" : "Ask to join"}
          </Button>
        </form>
        <div class="row row--center">
          <Button variant="quiet" small onClick={resend} busy={resending} busyLabel="Sending" disabled={wait > 0 || busy}>
            {wait > 0 ? `Send a new code (${wait} s)` : "Send a new code"}
          </Button>
          <Button
            variant="quiet"
            small
            disabled={busy}
            onClick={() => {
              setStep("form");
              setEditing(true);
              setEmail("");
              setProblem("");
            }}
          >
            Use a different email
          </Button>
        </div>
      </main>
    );
  }

  /* ----------------------------------- the form ----------------------------------- */
  return (
    <main class="screen">
      <div class="beat beat--row">
        <Mascot pose="messenger" size="sm" />
        <div class="beat__text">
          <Heading focus={false}>Ask to join real money</Heading>
          <p class="lede">{standingCopy(more ? "no-sends" : "none", { short, limit, left }).line}</p>
        </div>
      </div>
      <form
        class="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        noValidate
      >
        {known && !editing ? (
          <p class="fine">
            We'll use the email that backs up this account: <strong class="break">{maskEmail(known)}</strong>.{" "}
            <button
              type="button"
              class="link link--button"
              onClick={() => {
                setEditing(true);
                setEmail("");
                setProblem("");
              }}
            >
              Use a different email
            </button>
          </p>
        ) : (
          <>
            <TextField
              id="ask-email"
              label="Your email"
              type="email"
              inputMode="email"
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onValue={setEmail}
              readOnly={busy}
              invalid={Boolean(problem)}
              describedBy={problem ? "ask-problem" : "ask-hint"}
              autoFocus
            />
            {problem ? null : (
              <p class="fine" id="ask-hint">
                Use the email that backs up this account ({short}).
              </p>
            )}
          </>
        )}
        {problem ? (
          <Notice tone="error" id="ask-problem">
            {problem}
          </Notice>
        ) : null}
        <Button type="submit" busy={busy} busyLabel="Asking" disabled={!address()}>
          {more ? "Ask for more sends" : "Ask to join"}
        </Button>
      </form>
      <p class="fine">{DISCLOSE_PILOT_ASK}</p>
    </main>
  );
}
