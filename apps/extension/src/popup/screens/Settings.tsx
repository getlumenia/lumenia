/**
 * Settings: which account, which money, how long before it locks, and the ways out.
 *
 * Switching to real money is the one step with ceremony. It asks the pilot first (forced, so the
 * answer is fresh), says "invite-only" if the account is not on the list, shows the one-time
 * early-preview note and waits for "I understand", and only then changes the money. Every refusal
 * from the worker is shown right there, in its own words when it has a plain one.
 */
import { useState } from "preact/hooks";
import { AUTOLOCK_CHOICES, DAY_CAP_USD, TX_CAP_USD, URLS, VERSION } from "../../config";
import { formatUsd } from "../../core";
import type { AutolockMin } from "../../config";
import { openLinksMessage } from "../../lib/errors";
import { openLinks } from "../../lib/links";
import type { NetId, PilotInfo } from "../../lib/types";
import { ask } from "../api";
import { useApp } from "../context";
import { usePilot } from "../data";
import { useEscape } from "../escape";
import { plainSentence, shortAddress } from "../format";
import { useAlive, useFlash } from "../hooks";
import { forgetPopupState } from "../local";
import { IconCheck, IconCopy } from "../icons";
import { Button, ExtLink, Notice } from "../ui";

type NetUi =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "invite-only" }
  | { kind: "warning" }
  | { kind: "switching" }
  | { kind: "error"; text: string; web?: boolean };

const WARNING =
  "Real money is an early preview. It hasn't been reviewed by an outside security firm yet, so keep amounts tiny.";

export function Settings({ locked = false }: { locked?: boolean }) {
  const { ws, refresh, go, records, reloadRecords } = useApp();
  const alive = useAlive();
  const pilot = usePilot(ws);
  const net: NetId = ws.settings.net;
  const pubkey = ws.account?.pubkey ?? "";

  const [netUi, setNetUi] = useState<NetUi>({ kind: "idle" });
  const [checked, setChecked] = useState<PilotInfo | null>(null);
  const [copied, flashCopied] = useFlash();
  const [confirmForget, setConfirmForget] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  /** the worker's open-links refusal, when it knew of links this screen had not loaded */
  const [workerOpen, setWorkerOpen] = useState<string | null>(null);
  const open = openLinks(records);
  const openNote = workerOpen ?? (open.length > 0 ? openLinksMessage(open) : null);
  const [lockMessage, setLockMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEscape(() => {
    if (confirmForget) {
      setConfirmForget(false);
      return true;
    }
    if (netUi.kind === "invite-only" || netUi.kind === "warning" || netUi.kind === "error") {
      setNetUi({ kind: "idle" });
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

  /* ----------------------------------- the money in use ----------------------------------- */

  async function chooseReal() {
    if (net === "public" || netUi.kind === "checking" || netUi.kind === "switching") return;
    setNetUi({ kind: "checking" });
    const p = await ask("pilot.status", { force: true });
    if (!alive.current) return;
    if (!p.ok) {
      setNetUi({ kind: "error", text: plainSentence(p.message) ?? "We couldn't check right now. Try again in a moment." });
      return;
    }
    if (!p.data) {
      setNetUi({ kind: "error", text: "We couldn't check right now. Try again in a moment." });
      return;
    }
    setChecked(p.data);
    if (!p.data.approved) {
      setNetUi({ kind: "invite-only" });
      return;
    }
    if (p.data.limit > 0 && p.data.used >= p.data.limit) {
      setNetUi({ kind: "error", text: "You've used all your real-money sends in the pilot. Practice money still works." });
      return;
    }
    if (!ws.settings.mainnetAck) {
      setNetUi({ kind: "warning" });
      return;
    }
    await switchTo("public");
  }

  async function understand() {
    setNetUi({ kind: "switching" });
    const a = await ask("settings.set", { patch: { mainnetAck: true } });
    if (!alive.current) return;
    if (!a.ok) {
      setNetUi({ kind: "error", text: plainSentence(a.message) ?? "We couldn't save that. Try again." });
      return;
    }
    await switchTo("public");
  }

  async function switchTo(target: NetId) {
    setNetUi({ kind: "switching" });
    const r = await ask("network.set", { net: target });
    if (!alive.current) return;
    if (!r.ok) {
      setNetUi({
        kind: "error",
        text: plainSentence(r.message) ?? "We couldn't switch just now. Try again in a moment.",
        web: r.code === "needs-password",
      });
      return;
    }
    setNetUi({ kind: "idle" });
    await refresh();
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
    const r = await ask("forget", { confirm: "FORGET", ...(openNote ? { leaveOpenLinks: true as const } : {}) });
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

  const approved = Boolean((pilot ?? checked)?.approved);
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
              disabled={netUi.kind === "switching" || netUi.kind === "checking"}
              onClick={() => (net === "testnet" ? undefined : void switchTo("testnet"))}
            >
              <span class="seg__name">Practice money (testnet)</span>
              <span class="seg__sub">Play dollars to try it out.</span>
            </button>
            <button
              type="button"
              class={net === "public" ? "seg__opt seg__opt--real is-on" : "seg__opt seg__opt--real"}
              aria-pressed={net === "public"}
              disabled={netUi.kind === "switching" || netUi.kind === "checking"}
              onClick={() => void chooseReal()}
            >
              <span class="seg__name">Real money (mainnet)</span>
              <span class="seg__sub">Real dollars, capped.</span>
            </button>
          </div>

          {netUi.kind === "checking" ? <p class="fine" role="status">Checking your access to real money</p> : null}
          {netUi.kind === "switching" ? <p class="fine" role="status">Switching</p> : null}

          {netUi.kind === "invite-only" ? (
            <Notice>
              <strong>Real money is invite-only for now.</strong> This account isn't on the list yet.{" "}
              <ExtLink href={URLS.pilot} class="nowrap">
                Ask to join
              </ExtLink>
            </Notice>
          ) : null}

          {netUi.kind === "warning" ? (
            <div class="warning" role="group" aria-label="Before you use real money">
              <h3 class="warning__title">Before you use real money</h3>
              <p>{WARNING}</p>
              <p>
                Links are capped at {formatUsd(TX_CAP_USD)} each and {formatUsd(DAY_CAP_USD)} a day
                {checked && checked.pilot && checked.limit > 0 ? `, and this account has ${Math.max(0, checked.limit - checked.used)} of ${checked.limit} sends left` : ""}.
              </p>
              <div class="row">
                <Button small onClick={understand}>
                  I understand
                </Button>
                <Button small variant="secondary" onClick={() => setNetUi({ kind: "idle" })}>
                  Not now
                </Button>
              </div>
            </div>
          ) : null}

          {netUi.kind === "error" ? (
            <Notice tone="error">
              {netUi.text}
              {netUi.web ? (
                <>
                  {" "}
                  <ExtLink href={URLS.settings}>Open Lumenia settings</ExtLink>
                </>
              ) : null}
            </Notice>
          ) : null}

          {net === "public" ? (
            <p class="fine">
              {left !== null && pilot ? `${left} of ${pilot.limit} real-money sends left. ` : ""}
              Up to {formatUsd(TX_CAP_USD)} a link and {formatUsd(DAY_CAP_USD)} a day.
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
            {openNote ? (
              <p class="confirm__text">{openNote}</p>
            ) : (
              <p class="confirm__text">
                This removes the account and your list of links from this browser. Your money stays where it is, and you can restore again
                from your backup.
              </p>
            )}
            <div class="row">
              <Button small variant="danger" onClick={forget} busy={forgetting} busyLabel="Forgetting">
                {openNote ? "Forget anyway" : "Forget this account"}
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
