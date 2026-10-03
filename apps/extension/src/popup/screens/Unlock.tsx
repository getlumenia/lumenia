/**
 * The account is here but locked (the key is only kept unlocked for a few minutes at a time).
 * Opening it runs Argon2id on the password, which takes a few seconds, so the wait is said out loud.
 */
import { useState } from "preact/hooks";
import { ask } from "../api";
import { useApp } from "../context";
import { plainSentence, shortAddress } from "../format";
import { useAlive } from "../hooks";
import { BrandBar, Button, Heading, Notice, Progress, TextField } from "../ui";

export function Unlock() {
  const { ws, refresh, go } = useApp();
  const alive = useAlive();
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");

  async function submit(e: Event) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setProblem("");
    const r = await ask("unlock", { password });
    if (!alive.current) return;
    if (!r.ok) {
      setBusy(false);
      setProblem(
        r.code === "bad-password"
          ? "That password doesn't unlock this account."
          : r.code === "needs-password"
            ? "This account has no password lock yet, so it can't be opened here. Add one on getlumenia.com."
            : (plainSentence(r.message) ?? "Something went wrong. Try again."),
      );
      return;
    }
    setPassword("");
    await refresh();
    if (alive.current) setBusy(false);
  }

  return (
    <>
      <BrandBar />
      <main class="screen">
        <Heading focus={false}>Welcome back</Heading>
        <p class="lede">
          Enter your password to unlock{ws.account ? <> <span class="mono-ish">{shortAddress(ws.account.pubkey)}</span></> : null}.
        </p>
        <form class="stack" onSubmit={submit}>
          <TextField
            id="unlock-password"
            label="Password"
            type={show ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onValue={setPassword}
            readOnly={busy}
            invalid={Boolean(problem)}
            describedBy={problem ? "unlock-problem" : busy ? "unlock-progress" : undefined}
            autoFocus
            trailing={
              <button type="button" class="field__toggle" onClick={() => setShow((s) => !s)} aria-pressed={show}>
                {show ? "Hide" : "Show"}
              </button>
            }
          />
          {problem ? (
            <Notice tone="error" id="unlock-problem">
              {problem}
            </Notice>
          ) : null}
          {busy ? (
            <div class="progress-note" id="unlock-progress">
              <p class="fine">Unlocking. This takes a few seconds.</p>
              <Progress label="Unlocking" />
            </div>
          ) : null}
          <Button type="submit" busy={busy} busyLabel="Unlocking" disabled={!password}>
            Unlock
          </Button>
        </form>
        <div class="screen__spacer" />
        <p class="fine fine--center">
          Not you?{" "}
          <button type="button" class="link link--button" onClick={() => go("settings")}>
            Forget this account
          </button>
        </p>
      </main>
    </>
  );
}
