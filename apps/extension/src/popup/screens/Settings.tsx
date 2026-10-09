/**
 * Settings: which account, which money, how long before it locks, and the ways out.
 *
 * The money here is the same switch as the one in the header (netswitch.tsx): practice money is one
 * tap, real money asks the pilot first, says "invite-only" if the account is not on the list, shows
 * the one-time real-money note and waits for "I understand". Every refusal from the worker is
 * shown right there, in its own words when it has a plain one.
 */
import { useState } from "preact/hooks";
import { AUTOLOCK_CHOICES, URLS, VERSION } from "../../config";
import type { AutolockMin } from "../../config";
import { CAPS_SENTENCE } from "../../lib/copy";
import { MESSAGES, openLinksMessage } from "../../lib/errors";
import { openLinks } from "../../lib/links";
import { ask } from "../api";
import { useApp } from "../context";
import { usePilot } from "../data";
import { useEscape } from "../escape";
import { plainSentence, shortAddress } from "../format";
import { useAlive, useFlash } from "../hooks";
import { forgetPopupState } from "../local";
import { IconCheck, IconCopy } from "../icons";
import { NetPanel, useNetSwitch } from "../netswitch";
import { Button, ExtLink, Notice } from "../ui";

export function Settings({ locked = false }: { locked?: boolean }) {
  const { ws, refresh, go, records, reloadRecords } = useApp();
  const alive = useAlive();
  const pilot = usePilot(ws);
  const sw = useNetSwitch();
  const net = sw.net;
  const pubkey = ws.account?.pubkey ?? "";

  const [copied, flashCopied] = useFlash();
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  /** the worker's open-links refusal, when it knew of links this screen had not loaded */
  const [workerOpen, setWorkerOpen] = useState<string | null>(null);
  const open = openLinks(records);
  const openNote = workerOpen ?? (open.length > 0 ? openLinksMessage(open) : null);
  /** an account made here and never backed up: forgetting it deletes its only copy */
  const lossNote = ws.backup.needed ? MESSAGES["not-backed-up"] : null;
  const [lockMessage, setLockMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEscape(() => {
    if (confirmForget) {
      setConfirmForget(false);
      return true;
    }
    if (sw.ui.kind === "invite-only" || sw.ui.kind === "warning" || sw.ui.kind === "error") {
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

  const approved = Boolean((pilot ?? sw.checked)?.approved);
  const left = pilot && pilot.pilot && pilot.limit > 0 ? Math.max(0, pilot.limit - pilot.used) : null;

  return (
    <main class="screen screen--list">
      {/* ------------------------------ account ------------------------------ */}
      <section class="card group">
        <h2 class="group__title">Account</h2>
        <div class="kv">
          <code class="kv__value" title={pubkey}>
            {shortAddress(pubkey)}
          </code>
          <Button small variant="secondary" onClick={copyAddress} aria-label="Copy account address">
            {copied ? <IconCheck /> : <IconCopy />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {ws.backup.needed && !locked ? (
          <div class="kv kv--note">
            <p class="kv__note">Not backed up yet. It lives only in this browser.</p>
            <Button small onClick={() => go("backup")}>
              Back it up
            </Button>
          </div>
        ) : null}
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

          {net === "public" ? (
            <p class="fine">
              {left !== null && pilot ? `${left} of ${pilot.limit} real-money sends left. ` : ""}
              {CAPS_SENTENCE}
            </p>
          ) : approved ? (
            <p class="fine">You're approved for real money.</p>
          ) : null}
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
          <p class="fine">Your key locks itself after this long without use.</p>
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
              {lossNote ? (
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
