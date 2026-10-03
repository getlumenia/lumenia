/**
 * The home screen: how much, optionally from whom, optionally behind a password, then "Make the link".
 *
 * Everything it shows next to the form is read, not assumed: the balance comes from the worker, the
 * pilot standing is the worker's cached answer (refreshed at most once a minute, and only on real
 * money). The caps are named here so they are read BEFORE the person signs; the sponsor, and the
 * worker in front of it, are what actually enforce them.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { DAY_CAP_USD, MIN_USD, TX_CAP_USD, URLS } from "../../config";
import { claimPasswordProblem, formatUsd, sanitizeAmountInput } from "../../core";
import type { NetId } from "../../lib/types";
import { ask } from "../api";
import { useApp } from "../context";
import { type BalanceView, useBalance, usePilot } from "../data";
import { openRecord, type Draft, type FormError } from "../flow";
import { centsOf, plainSentence } from "../format";
import { useAlive } from "../hooks";
import { Bubble, Button, ExtLink, Mascot, Switch, TextField } from "../ui";

export interface SendInput {
  amount: string;
  from: string;
  password?: string;
  /** the person saw that an earlier send is unconfirmed and chose to make a new link anyway */
  anyway?: boolean;
}

interface Props {
  draft: Draft;
  patch: (p: Partial<Draft>) => void;
  formError: FormError | null;
  setFormError: (e: FormError | null) => void;
  onSend: (input: SendInput) => void;
  onCancelInsert: () => void;
}

export function SendForm({ draft, patch, formError, setFormError, onSend, onCancelInsert }: Props) {
  const { ws, net, records, go } = useApp();
  const alive = useAlive();
  const real = net === "public";
  const pilot = usePilot(ws);
  const balance = useBalance(net);

  const lock = draft.lock ?? real;
  const from = draft.from ?? ws.settings.from;
  const amountRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [getting, setGetting] = useState(false);
  const [practiceNote, setPracticeNote] = useState("");
  const [askAnyway, setAskAnyway] = useState(false);
  // The name and the link password sit behind one button; real money opens it (its password is on).
  const [more, setMore] = useState(() => lock || Boolean(draft.from));
  useEffect(() => {
    amountRef.current?.focus();
  }, []);

  const unconfirmed = openRecord(records, Date.now(), net);
  const amountError = formError?.field === "amount" ? formError.text : "";
  const passwordError = formError?.field === "password" ? formError.text : "";

  /** The form as a send request, or null after pointing at the field that needs fixing. */
  function validated(): SendInput | null {
    const cents = centsOf(draft.amount.replace(/\.$/, ""));
    if (cents === null || cents <= 0) {
      setFormError({ field: "amount", text: "Enter an amount, like 5 or 2.50." });
      amountRef.current?.focus();
      return null;
    }
    if (cents < (centsOf(MIN_USD) ?? 1)) {
      setFormError({ field: "amount", text: `The smallest link is ${formatUsd(MIN_USD)}.` });
      amountRef.current?.focus();
      return null;
    }
    if (lock) {
      const problem = claimPasswordProblem(draft.password);
      if (problem) {
        setFormError({ field: "password", text: problem });
        passwordRef.current?.focus();
        return null;
      }
    }
    setFormError(null);
    return {
      amount: draft.amount.replace(/\.$/, ""),
      from: from.trim(),
      ...(lock ? { password: draft.password } : {}),
    };
  }

  function submit(e: Event) {
    e.preventDefault();
    const input = validated();
    if (!input) return;
    // An earlier send may still land: a new link then puts the money in twice. Ask first.
    if (unconfirmed) {
      setAskAnyway(true);
      return;
    }
    onSend(input);
  }

  function sendAnyway() {
    const input = validated();
    if (input) onSend({ ...input, anyway: true });
  }

  async function getPractice() {
    setGetting(true);
    setPracticeNote("");
    const r = await ask("testmoney");
    if (!alive.current) return;
    setGetting(false);
    if (r.ok) balance.set(r.data);
    else setPracticeNote(plainSentence(r.message) ?? "We couldn't get practice dollars just now. Try again in a moment.");
  }

  return (
    <main class="screen screen--send">
      <h1 class="sr-only">Send dollars by link</h1>
      {ws.pendingInsert ? (
        <div class="banner" role="status">
          <p class="banner__text">
            Your link will be pasted into the box you picked on <strong class="break">{ws.pendingInsert.host || "the page"}</strong>.
          </p>
          <Button variant="quiet" small onClick={onCancelInsert}>
            Cancel
          </Button>
        </div>
      ) : null}

      {unconfirmed && askAnyway ? (
        <div class="banner banner--warn banner--ask" role="alert">
          <p class="banner__text">
            A link you made earlier isn't confirmed yet. If it went through, a new one puts the money in twice.
          </p>
          <div class="row">
            <Button variant="secondary" small onClick={sendAnyway}>
              Send a new one anyway
            </Button>
            <Button variant="quiet" small onClick={() => go("links")}>
              See links
            </Button>
          </div>
        </div>
      ) : unconfirmed ? (
        <div class="banner banner--warn" role="status">
          <p class="banner__text">
            A link you made earlier isn't confirmed yet. Please don't send it again.
          </p>
          <Button variant="quiet" small onClick={() => go("links")}>
            See links
          </Button>
        </div>
      ) : null}

      {ws.backup.needed && !ws.pendingInsert && !unconfirmed ? (
        <div class="banner" role="status">
          <p class="banner__text">Your account lives only in this browser.</p>
          <Button variant="quiet" small onClick={() => go("backup")}>
            Back it up
          </Button>
        </div>
      ) : null}

      <div class="send__beat">
        <Mascot pose="messenger" size="xs" />
        <Bubble tail="left" class="send__bubble">
          How much are you sending?
        </Bubble>
      </div>

      <form class="send" onSubmit={submit} noValidate>
        <div class="field">
          <label class="field__label sr-only" for="amount">
            Amount
          </label>
          <div class={amountError ? "amount is-invalid" : "amount"}>
            <span class="amount__prefix" aria-hidden="true">
              $
            </span>
            <input
              ref={amountRef}
              id="amount"
              class="amount__input"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              spellcheck={false}
              placeholder="0.00"
              maxLength={12}
              value={draft.amount}
              aria-invalid={amountError ? true : undefined}
              aria-describedby={amountError ? "amount-error balance-line" : "balance-line"}
              onInput={(e) => {
                const el = e.currentTarget;
                const clean = sanitizeAmountInput(el.value);
                if (el.value !== clean) el.value = clean; // the box must show what will be sent
                patch({ amount: clean });
                if (formError?.field === "amount") setFormError(null);
              }}
            />
          </div>
          {amountError ? (
            <p class="field__error" id="amount-error" role="alert">
              {amountError}
            </p>
          ) : null}
        </div>

        <BalanceLine
          view={balance.view}
          net={net}
          amount={draft.amount}
          getting={getting}
          note={practiceNote}
          onGetPractice={getPractice}
          onRetry={balance.reload}
        />

        {more ? (
        <>
        <TextField
          id="from"
          label="From (optional)"
          placeholder="Your name"
          autoComplete="off"
          maxLength={40}
          value={from}
          onValue={(v) => patch({ from: v })}
        />

        <div class="lockbox">
          <Switch id="lock" checked={lock} onChange={(v) => patch({ lock: v })}>
            Make them enter a password
          </Switch>
          {lock ? (
            <>
              <TextField
                id="link-password"
                label="Password for the link"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                maxLength={256}
                value={draft.password}
                inputRef={passwordRef}
                invalid={Boolean(passwordError)}
                describedBy={passwordError ? "password-error password-hint" : "password-hint"}
                onValue={(v) => {
                  patch({ password: v });
                  if (formError?.field === "password") setFormError(null);
                }}
                trailing={
                  <button type="button" class="field__toggle" aria-pressed={showPassword} onClick={() => setShowPassword((s) => !s)}>
                    {showPassword ? "Hide" : "Show"}
                  </button>
                }
              />
              {passwordError ? (
                <p class="field__error" id="password-error" role="alert">
                  {passwordError}
                </p>
              ) : null}
              <p class="fine" id="password-hint">
                Tell them the password another way, like a call.
              </p>
            </>
          ) : null}
        </div>
        </>
        ) : (
          <button type="button" class="more" aria-expanded={false} onClick={() => setMore(true)}>
            {from.trim() ? `From ${from.trim()}. ` : ""}Add your name or a password
          </button>
        )}

        <div class="send__foot">
          {real ? <CapsLine pilotInfo={pilot} /> : <p class="caps">Practice money: play dollars, nothing here is real.</p>}
          <Button type="submit">Make the link</Button>
        </div>
      </form>
    </main>
  );
}

/** "You have $24.50", or why we cannot say, and the way out on practice money. */
function BalanceLine({
  view,
  net,
  amount,
  getting,
  note,
  onGetPractice,
  onRetry,
}: {
  view: BalanceView;
  net: NetId;
  amount: string;
  getting: boolean;
  note: string;
  onGetPractice: () => void;
  onRetry: () => void;
}) {
  const practice = net === "testnet";
  let text = "";
  let action: "practice" | "retry" | null = null;

  if (view.state === "loading") {
    text = "Checking your balance";
  } else if (view.state === "unreadable") {
    text = "We couldn't check your balance just now.";
    action = "retry";
  } else if (view.info.missing) {
    text = practice ? "Your account isn't open on practice money yet." : "Your account isn't open on real money yet.";
    if (practice) action = "practice";
  } else {
    const have = centsOf(view.info.usd);
    text = have === null ? "You have a balance we can't show right now." : `You have ${formatUsd(view.info.usd ?? "0")}`;
    const want = centsOf(amount.replace(/\.$/, "")) ?? 0;
    if (practice && have !== null && (have === 0 || have < want)) action = "practice";
  }

  return (
    <div class="balance" id="balance-line" aria-live="polite">
      <span class={view.state === "loading" ? "balance__text is-loading" : "balance__text"}>{text}</span>
      {action === "practice" ? (
        <Button variant="secondary" small onClick={onGetPractice} busy={getting} busyLabel="Getting practice dollars">
          Get practice dollars
        </Button>
      ) : null}
      {action === "retry" ? (
        <Button variant="quiet" small onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      {note ? <span class="balance__note">{note}</span> : null}
    </div>
  );
}

/** "Real money: up to $5.00 a link, $50.00 a day. 3 of 5 sends left." */
function CapsLine({ pilotInfo }: { pilotInfo: ReturnType<typeof usePilot> }) {
  if (pilotInfo && pilotInfo.pilot && !pilotInfo.approved) {
    return (
      <p class="caps" role="status">
        Real money is invite-only for now. <ExtLink href={URLS.pilot}>Ask to join</ExtLink>
      </p>
    );
  }
  const left =
    pilotInfo && pilotInfo.pilot && pilotInfo.limit > 0 ? ` ${Math.max(0, pilotInfo.limit - pilotInfo.used)} of ${pilotInfo.limit} sends left.` : "";
  return (
    <p class="caps">
      Real money: up to {formatUsd(TX_CAP_USD)} a link, {formatUsd(DAY_CAP_USD)} a day.{left}
    </p>
  );
}
