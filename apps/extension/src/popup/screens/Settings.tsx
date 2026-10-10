/**
 * Settings: which account, which money, how long before it locks, and the ways out.
 *
 * The account is named the way every Lumenia surface names it (LUMENIA ACCOUNT CONTRACT v1, 5.3):
 * its short address and the email it is backed up with. From here the person can bring another
 * account in its place (only once this one's backup is confirmed, so it can come back), change the
 * backup email, or add one an older version never kept.
 *
 * The money here is the same switch as the one in the header (netswitch.tsx): practice money is one
 * tap, real money asks the pilot first and says where this account stands in the words every surface
 * uses (lib/standing.ts), shows the one-time real-money note and waits for "I understand". Every
 * refusal from the worker is shown right there, in its own words when it has a plain one.
 */
import { useState } from "preact/hooks";
import { AUTOLOCK_CHOICES, URLS, VERSION } from "../../config";
import type { AutolockMin } from "../../config";
import { CAPS_SENTENCE } from "../../lib/copy";
import { MESSAGES, UNCONFIRMED_LOSS, openLinksMessage } from "../../lib/errors";
import { openLinks } from "../../lib/links";
import { CHECKING, sendsLeft, standingCopy } from "../../lib/standing";
import { ask } from "../api";
import { useApp } from "../context";
import { useBalance, useStanding } from "../data";
import { useEscape } from "../escape";
import { maskEmail, plainSentence, shortAddress, when } from "../format";
import { useAlive, useFlash } from "../hooks";
import { forgetPopupState } from "../local";
import { IconCheck, IconCopy } from "../icons";
import { NetPanel, useNetSwitch } from "../netswitch";
import { Button, ExtLink, Notice } from "../ui";
import { AccountLineView } from "./AccountLine";

/** The worker refuses "Use another account" in these words; the popup says them before it asks. */
const SWITCH_NEEDS_BACKUP = "Back this account up first. It lives only in this browser.";
const SWITCH_NEEDS_EMAIL = "Add your backup email first.";

export function Settings({ locked = false }: { locked?: boolean }) {
  const { ws, refresh, go, records, reloadRecords } = useApp();
  const alive = useAlive();
  const st = useStanding(ws);
  const sw = useNetSwitch();
  const net = sw.net;
  const pubkey = ws.account?.pubkey ?? "";
  const short = shortAddress(pubkey);
  const bound = ws.account?.bound ?? null;
  const email = ws.account?.email ?? null;

  const [copied, flashCopied] = useFlash();
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  /** the worker's open-links refusal, when it knew of links this screen had not loaded */
  const [workerOpen, setWorkerOpen] = useState<string | null>(null);
  const open = openLinks(records);
  const openNote = workerOpen ?? (open.length > 0 ? openLinksMessage(open) : null);
  /**
   * What forgetting this account may cost: an account made here and never backed up has no other
   * copy at all; one whose backup the server never confirmed as its own may have none either. Only a
   * confirmed backup is "restore again from your backup".
   */
  const lossNote = ws.backup.needed ? MESSAGES["not-backed-up"] : bound !== true ? UNCONFIRMED_LOSS : null;
  const [lockMessage, setLockMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [switchNote, setSwitchNote] = useState("");

  useEscape(() => {
    if (confirmForget) {
      setConfirmForget(false);
      return true;
    }
    if (sw.ui.kind === "standing" || sw.ui.kind === "warning" || sw.ui.kind === "error" || sw.ui.kind === "backup-first") {
      sw.dismiss();
      return true;
    }
    return false;
  });

  function copyAddress() {
    navigator.clipboard.writeText(pubkey).then(
      () => alive.current && flashCopied(),
      () => undefined,
    );
  }

  /* ----------------------------------- the account ----------------------------------- */

  /**
   * "Use another account": only an account whose backup is confirmed as its own may leave, so it can
   * be brought back (the worker checks it again, and once more with the server when it can).
   */
  function useAnother() {
    setSwitchNote("");
    if (ws.backup.needed || bound === false) {
      setSwitchNote(SWITCH_NEEDS_BACKUP);
      return;
    }
    if (bound !== true && !email) {
      setSwitchNote(SWITCH_NEEDS_EMAIL);
      return;
    }
    go("switch");
  }

  /* ----------------------------------- the rest ----------------------------------- */

  async function setAutolock(min: AutolockMin) {
    if (min === ws.settings.autolockMin || saving) return;
    setSaving(true);
    await ask("settings.set", { patch: { autolockMin: min } });
    await refresh();
    if (alive.current) setSaving(false);
  }

  async function lockNow() {
    setLockMessage("");
    const r = await ask("lock");
    if (!alive.current) return;
    if (!r.ok) {
      setLockMessage(plainSentence(r.message) ?? "We couldn't lock it just now.");
      return;
    }
    go("home");
    await refresh();
  }

  async function forget() {
    setForgetting(true);
    const r = await ask("forget", {
      confirm: "FORGET",
      ...(openNote ? { leaveOpenLinks: true as const } : {}),
      ...(lossNote ? { loseAccount: true as const } : {}),
    });
    if (!alive.current) return;
    setForgetting(false);
    if (!r.ok) {
      if (r.code === "open-links") {
        // Links this screen had not loaded: show what is at stake, and ask again.
        setWorkerOpen(plainSentence(r.message) ?? r.message);
        void reloadRecords();
        return;
      }
      setConfirmForget(false);
      setLockMessage(plainSentence(r.message) ?? "We couldn't do that just now. Try again.");
      return;
    }
    forgetPopupState();
    go("home");
    await refresh();
  }

  const info = st.info;
  const copyOf = info ? standingCopy(st.standing, { short, left: sendsLeft(info), limit: info.limit }) : null;

  return (
    <main class="screen screen--list">
      {/* ------------------------------ account ------------------------------ */}
      <section class="card group">
        <h2 class="group__title">Account</h2>
        <div class="kv">
          <code class="kv__value" title={pubkey}>
            {short}
          </code>
          <Button small variant="secondary" onClick={copyAddress} aria-label="Copy account address">
            {copied ? <IconCheck /> : <IconCopy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {!locked && net === "public" ? <RealMoneyCopyNote /> : null}
        {locked ? null : <AccountLineView onAction={(kind) => go(kind === "add-email" ? "add-email" : "change-email")} />}
        {ws.backup.needed && !locked ? (
          <div class="kv kv--note">
            <p class="kv__note">Not backed up yet. It lives only in this browser.</p>
            <Button small onClick={() => go("backup")}>
              Back it up
            </Button>
          </div>
        ) : null}
        {locked ? null : (
          <>
            {bound === true && email ? (
              <p class="fine">
                This account ({short}) stays backed up with {maskEmail(email)}. Its links show again when you bring it back.
              </p>
            ) : null}
            <div class="row">
              <Button small variant="secondary" onClick={useAnother}>
                Use another account
              </Button>
              {ws.backup.needed ? null : (
                <Button small variant="quiet" onClick={() => go("change-email")}>
                  Change backup email
                </Button>
              )}
            </div>
            {switchNote ? (
              <Notice tone="error">
                {switchNote}
                {switchNote === SWITCH_NEEDS_EMAIL ? (
                  <>
                    {" "}
                    <button type="button" class="link link--button" onClick={() => go("add-email")}>
                      Add your backup email
                    </button>
                  </>
                ) : null}
              </Notice>
            ) : null}
          </>
        )}
      </section>

      {/* ------------------------------ money ------------------------------ */}
      {locked ? null : (
        <section class="card group">
          <h2 class="group__title" id="money-title">
            Money
          </h2>
          <div class="seg" role="group" aria-labelledby="money-title">
            <button
              type="button"
              class={net === "testnet" ? "seg__opt is-on" : "seg__opt"}
              aria-pressed={net === "testnet"}
              disabled={sw.busy}
              onClick={() => sw.pick("testnet")}
            >
              <span class="seg__name">Practice money (testnet)</span>
              <span class="seg__sub">Play dollars to try it out.</span>
            </button>
            <button
              type="button"
              class={net === "public" ? "seg__opt seg__opt--real is-on" : "seg__opt seg__opt--real"}
              aria-pressed={net === "public"}
              disabled={sw.busy}
              onClick={() => sw.pick("public")}
            >
              <span class="seg__name">Real money (mainnet)</span>
              <span class="seg__sub">Real dollars, capped.</span>
            </button>
          </div>

          <NetPanel sw={sw} />

          {/* Where this account stands, from the last answer, with its age, and a way to ask again. */}
          {st.checking ? (
            <p class="fine" role="status">
              {CHECKING}
            </p>
          ) : copyOf && info ? (
            <div class="kv kv--note">
              <p class="kv__note">
                <strong>{copyOf.title}</strong> {copyOf.line} Checked {when(info.at)}.
                {st.failed ? " We couldn't check again just now." : ""}
              </p>
              <Button small variant="secondary" onClick={st.check}>
                Check again
              </Button>
            </div>
          ) : null}
          {net === "public" ? <p class="fine">{CAPS_SENTENCE}</p> : null}
        </section>
      )}

      {/* ------------------------------ lock ------------------------------ */}
      {locked ? null : (
        <section class="card group">
          <h2 class="group__title" id="autolock-title">
            Lock after
          </h2>
          <div class="seg seg--3" role="group" aria-labelledby="autolock-title">
            {AUTOLOCK_CHOICES.map((m) => (
              <button
                key={m}
                type="button"
                class={ws.settings.autolockMin === m ? "seg__opt seg__opt--plain is-on" : "seg__opt seg__opt--plain"}
                aria-pressed={ws.settings.autolockMin === m}
                disabled={saving}
                onClick={() => void setAutolock(m)}
              >
                <span class="seg__name">{m} minutes</span>
              </button>
            ))}
          </div>
          <p class="fine">Your key in this extension locks itself after this long without use.</p>
          <Button variant="secondary" onClick={lockNow}>
            Lock now
          </Button>
          {lockMessage ? <Notice tone="error">{lockMessage}</Notice> : null}
        </section>
      )}

      {/* ------------------------------ forget ------------------------------ */}
      <section class="card group">
        <h2 class="group__title">This account</h2>
        {confirmForget ? (
          <div class="confirm" role="group" aria-label="Forget this account">
            {lossNote ? <p class="confirm__text confirm__text--loss">{lossNote}</p> : null}
            {openNote ? (
              <p class="confirm__text">{openNote}</p>
            ) : lossNote ? null : (
              <p class="confirm__text">
                This removes the account and your list of links from this browser. Your money stays where it is, and you can restore again
                from your backup.
              </p>
            )}
            <div class="row">
              {ws.backup.needed ? (
                <Button small onClick={() => go("backup")} disabled={forgetting}>
                  Back it up first
                </Button>
              ) : null}
              <Button small variant="danger" onClick={forget} busy={forgetting} busyLabel="Forgetting">
                {openNote || lossNote ? "Forget anyway" : "Forget this account"}
              </Button>
              <Button small variant="secondary" onClick={() => setConfirmForget(false)} disabled={forgetting}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="quiet" class="btn--danger-text" onClick={() => setConfirmForget(true)}>
            Forget this account
          </Button>
        )}
        {locked && lockMessage ? <Notice tone="error">{lockMessage}</Notice> : null}
      </section>

      {/* ------------------------------ links ------------------------------ */}
      <section class="card group group--links">
        <ExtLink href={URLS.privacy}>Privacy</ExtLink>
        <ExtLink href={URLS.settings}>Lumenia settings on the web</ExtLink>
        <p class="fine">Lumenia extension, version {VERSION}</p>
      </section>
    </main>
  );
}

/**
 * On real money, an account that is not open there yet cannot receive dollars: copying its address
 * for someone to pay it says so (an approved account opens itself with "Open it on real money" on
 * the home screen).
 */
function RealMoneyCopyNote() {
  const balance = useBalance("public");
  const v = balance.view;
  if (v.state !== "ready" || !(v.info.missing || v.info.line === false)) return null;
  return <p class="fine">Open it on real money first, or dollars sent here can't arrive.</p>;
}
