/**
 * A new account, made in this browser: one password, typed twice. It locks the key here (Argon2id
 * then AES-GCM, the website's own record) and it is the password the backup opens with, so it is
 * held to the website's own floor (password-strength.ts) before anything is made.
 */
import { useState } from "preact/hooks";
import { passwordStrength } from "../../core";
import { ask } from "../api";
import { useApp } from "../context";
import { plainSentence } from "../format";
import { useAlive } from "../hooks";
import { Button, Heading, Mascot, Notice, Progress, SubBar, TextField } from "../ui";

export function Create() {
  const { refresh, leaveRestore, justCreated } = useApp();
  const alive = useAlive();
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field: "password" | "again" | "form"; text: string } | null>(null);

  async function submit(e: Event) {
    e.preventDefault();
    if (busy) return;
    const strength = passwordStrength(password);
    if (!strength.ok) {
      setProblem({ field: "password", text: strength.reason ?? "Pick a stronger password." });
      return;
    }
    if (again !== password) {
      setProblem({ field: "again", text: "The two passwords don't match." });
      return;
    }
    setBusy(true);
    setProblem(null);
    const r = await ask("account.create", { password });
    if (!alive.current) return;
    if (!r.ok) {
      setBusy(false);
      setProblem({
        field: r.code === "weak-password" ? "password" : "form",
        text: plainSentence(r.message) ?? "We couldn't make your account. Try again.",
      });
      return;
    }
    setPassword("");
    setAgain("");
    justCreated();
    await refresh();
    if (alive.current) setBusy(false);
  }

  const toggle = (
    <button type="button" class="field__toggle" onClick={() => setShow((s) => !s)} aria-pressed={show}>
      {show ? "Hide" : "Show"}
    </button>
  );

  return (
    <>
      <SubBar title="New account" onBack={leaveRestore} />
      <main class="screen">
        <div class="beat beat--row">
          <Mascot pose="phone" size="sm" />
          <div class="beat__text">
            <Heading>Pick a password</Heading>
            <p class="lede">It locks your account in this browser. It is the only key to your money, so keep it safe.</p>
          </div>
        </div>
        <form class="stack" onSubmit={submit} noValidate>
          <TextField
            id="new-password"
            label="Password"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            maxLength={1024}
            value={password}
            onValue={(v) => {
              setPassword(v);
              if (problem?.field === "password") setProblem(null);
            }}
            readOnly={busy}
            invalid={problem?.field === "password"}
            describedBy={problem?.field === "password" ? "create-problem" : "create-hint"}
            autoFocus
            trailing={toggle}
          />
          <TextField
            id="new-password-again"
            label="Type it again"
            type={show ? "text" : "password"}
            autoComplete="new-password"
            maxLength={1024}
            value={again}
            onValue={(v) => {
              setAgain(v);
              if (problem?.field === "again") setProblem(null);
            }}
            readOnly={busy}
            invalid={problem?.field === "again"}
            describedBy={problem?.field === "again" ? "create-problem" : undefined}
          />
          {problem ? (
            <Notice tone="error" id="create-problem">
              {problem.text}
            </Notice>
          ) : (
            <p class="fine" id="create-hint">
              At least 10 characters. A short phrase works well.
            </p>
          )}
          {busy ? (
            <div class="progress-note">
              <p class="fine">Making your account. This takes a few seconds.</p>
              <Progress label="Making your account" />
            </div>
          ) : null}
          <Button type="submit" busy={busy} busyLabel="Making your account" disabled={!password || !again}>
            Create my account
          </Button>
        </form>
      </main>
    </>
  );
}
