/**
 * Which money the popup uses, and the one way to change it: the switch that is always in the header,
 * and the same switch in Settings. Both run the logic below, so the two can never disagree.
 *
 * Practice money is one tap. Real money keeps its ceremony, because it is the one switch with
 * consequences: an account that lives only in this browser is sent to back it up first, the pilot is
 * asked first (forced, so the answer is fresh), and its answer is said as the account's standing in
 * the words every surface uses (lib/standing.ts): invite-only (with Ask to join, here in the
 * extension, for this account), on the list, not approved for now, taken off, or could not check.
 * The real-money note is shown once and waits for "I understand", and only then does the worker
 * change the money. The worker checks all of it again (router.ts, network.set), so a popup that
 * skipped a step still could not switch.
 */
import { useState } from "preact/hooks";
import { URLS } from "../config";
import { CAPS_SENTENCE, REAL_MONEY_WARNING } from "../lib/copy";
import { CHECKING, pilotStanding, sendsLeft, standingCopy, type Standing } from "../lib/standing";
import type { ErrorCode, NetId, PilotInfo } from "../lib/types";
import { ask } from "./api";
import { useApp } from "./context";
import { useEscape } from "./escape";
import { plainSentence, realMoneyTitle, shortAddress, when } from "./format";
import { useAlive } from "./hooks";
import { Button, ExtLink, Notice, TopBar } from "./ui";

export type NetUi =
  | { kind: "idle" }
  | { kind: "checking" }
  /** a standing that does not open real money: said in its own words, with what can be done */
  | { kind: "standing"; standing: Standing }
  /** the account lives only in this browser: real money waits for the backup */
  | { kind: "backup-first" }
  | { kind: "warning" }
  | { kind: "switching"; to: NetId }
  | { kind: "error"; text: string; web?: boolean };

export interface NetSwitchState {
  net: NetId;
  ui: NetUi;
  /** a check or a switch is running: the switch takes no second tap */
  busy: boolean;
  /** the pilot answer the last real-money check got, for the "sends left" line */
  checked: PilotInfo | null;
  /** the header's description of real money, from the last pilot answer (format.ts realMoneyTitle) */
  realTitle: string;
  /** the short address of the account in use */
  short: string;
  pick: (target: NetId) => void;
  /** open the backup steps (the "back it up first" answer) */
  backUp: () => void;
  /** open the Ask to join screen for this account */
  askToJoin: () => void;
  /** ask the pilot again (Check again, Try again) */
  recheck: () => void;
  understand: () => void;
  dismiss: () => void;
}

/** The standing a refusal from network.set names, when it names one. */
function standingOf(code: ErrorCode, message: string): Standing | null {
  switch (code) {
    case "not-approved":
      return /settings|accept/i.test(message) ? null : "none";
    case "pilot-pending":
      return "pending";
    case "pilot-declined":
      return "declined";
    case "pilot-revoked":
      return "revoked";
    case "pilot-unknown":
      return "unknown";
    default:
      return null;
  }
}

export function useNetSwitch(): NetSwitchState {
  const { ws, refresh, go } = useApp();
  const alive = useAlive();
  const [ui, setUi] = useState<NetUi>({ kind: "idle" });
  const [checked, setChecked] = useState<PilotInfo | null>(null);
  const net = ws.settings.net;
  const busy = ui.kind === "checking" || ui.kind === "switching";
  const short = shortAddress(ws.account?.pubkey ?? "");

  async function switchTo(target: NetId): Promise<void> {
    setUi({ kind: "switching", to: target });
    const r = await ask("network.set", { net: target });
    if (!alive.current) return;
    if (!r.ok && r.code === "needs-backup") {
      setUi({ kind: "backup-first" });
      return;
    }
    if (!r.ok) {
      const s = standingOf(r.code, r.message);
      if (s) {
        setUi({ kind: "standing", standing: s });
        return;
      }
      setUi({
        kind: "error",
        text: plainSentence(r.message) ?? "We couldn't switch just now. Try again in a moment.",
        web: r.code === "needs-password",
      });
      return;
    }
    setUi({ kind: "idle" });
    await refresh();
  }

  async function chooseReal(): Promise<void> {
    /* Said first, and without asking anyone: an account that lives only in this browser does not
       move real money, whatever the pilot says (the worker refuses it again, router.ts). */
    if (ws.backup.needed) {
      setUi({ kind: "backup-first" });
      return;
    }
    setUi({ kind: "checking" });
    const p = await ask("pilot.status", { force: true });
    if (!alive.current) return;
    if (!p.ok || !p.data) {
      // Could not ask: "unknown", never "not approved".
      setUi({ kind: "standing", standing: "unknown" });
      return;
    }
    setChecked(p.data);
    const s = pilotStanding(p.data);
    if (s !== "approved" && s !== "no-sends" && s !== "open") {
      setUi({ kind: "standing", standing: s });
      void refresh(); // the header title follows the fresh answer
      return;
    }
    if (!ws.settings.mainnetAck) {
      setUi({ kind: "warning" });
      return;
    }
    await switchTo("public");
  }

  async function understandNote(): Promise<void> {
    setUi({ kind: "switching", to: "public" });
    const a = await ask("settings.set", { patch: { mainnetAck: true } });
    if (!alive.current) return;
    if (!a.ok) {
      setUi({ kind: "error", text: plainSentence(a.message) ?? "We couldn't save that. Try again." });
      return;
    }
    await switchTo("public");
  }

  return {
    net,
    ui,
    busy,
    checked,
    realTitle: realMoneyTitle(ws.pilot, short),
    short,
    pick: (target) => {
      if (busy || target === net) return;
      void (target === "public" ? chooseReal() : switchTo("testnet"));
    },
    backUp: () => {
      setUi({ kind: "idle" });
      go("backup");
    },
    askToJoin: () => {
      setUi({ kind: "idle" });
      go("ask");
    },
    recheck: () => void chooseReal(),
    understand: () => void understandNote(),
    dismiss: () => setUi({ kind: "idle" }),
  };
}

/** What the switch has to say, when it has something to say: the check, the answer, the note. */
export function NetPanel({ sw }: { sw: NetSwitchState }) {
  const { ws } = useApp();
  const { ui, checked } = sw;
  switch (ui.kind) {
    case "checking":
      return (
        <p class="fine" role="status">
          {CHECKING}
        </p>
      );
    case "switching":
      return (
        <p class="fine" role="status">
          {ui.to === "public" ? "Switching to real money" : "Switching to practice money"}
        </p>
      );
    case "standing": {
      const info = checked ?? ws.pilot;
      const c = standingCopy(ui.standing, { short: sw.short, left: info ? sendsLeft(info) : 0, limit: info?.limit ?? 0 });
      return (
        <>
          <Notice tone={ui.standing === "unknown" ? "error" : "info"}>
            <strong>{c.title}</strong> {c.line}
            {ui.standing === "unknown" && ws.pilot ? <> Last checked {when(ws.pilot.at)}.</> : null}
          </Notice>
          <div class="row">
            {ui.standing === "none" ? (
              <Button small onClick={sw.askToJoin}>
                {c.action}
              </Button>
            ) : null}
            {ui.standing === "pending" || ui.standing === "unknown" ? (
              <Button small onClick={sw.recheck}>
                {c.action}
              </Button>
            ) : null}
            <Button small variant="secondary" onClick={sw.dismiss}>
              Not now
            </Button>
          </div>
        </>
      );
    }
    case "backup-first":
      return (
        <>
          <Notice>
            <strong>Back it up first.</strong> This account lives only in this browser, and real money
            waits until it is backed up.
          </Notice>
          <div class="row">
            <Button small onClick={sw.backUp}>
              Back it up
            </Button>
            <Button small variant="secondary" onClick={sw.dismiss}>
              Not now
            </Button>
          </div>
        </>
      );
    case "warning":
      return (
        <div class="warning" role="group" aria-label="Before you use real money">
          <h3 class="warning__title">Before you use real money</h3>
          {/* The warning is one sentence everywhere it is shown (lib/copy.ts); the caps follow it on their own. */}
          <p>{REAL_MONEY_WARNING}</p>
          <p>
            {CAPS_SENTENCE}
            {checked && checked.pilot && checked.limit > 0 ? ` This account has ${sendsLeft(checked)} of ${checked.limit} sends left.` : ""}
          </p>
          <div class="row">
            <Button small onClick={sw.understand}>
              I understand
            </Button>
            <Button small variant="secondary" onClick={sw.dismiss}>
              Not now
            </Button>
          </div>
        </div>
      );
    case "error":
      return (
        <>
          <Notice tone="error">
            {ui.text}
            {ui.web ? (
              <>
                {" "}
                <ExtLink href={URLS.settings}>Open Lumenia settings</ExtLink>
              </>
            ) : null}
          </Notice>
          <div class="row">
            <Button small variant="secondary" onClick={sw.dismiss}>
              OK
            </Button>
          </div>
        </>
      );
    default:
      return null;
  }
}

/**
 * The home screens' header with the switch in it. When the switch needs a word (a real-money check,
 * the invite-only answer, the one-time note, a refusal) it opens a panel under the header, over the
 * screen; Escape, a tap outside or "Not now" closes it. Switching back to practice money says nothing:
 * it just happens.
 */
export function NetHeader({ busy, onLinks, onSettings }: { busy: boolean; onLinks: () => void; onSettings: () => void }) {
  const sw = useNetSwitch();
  const open = sw.ui.kind !== "idle" && !(sw.ui.kind === "switching" && sw.ui.to === "testnet");
  useEscape(() => {
    if (!open || sw.busy) return false;
    sw.dismiss();
    return true;
  });
  return (
    <>
      <TopBar net={sw.net} switchDisabled={busy || sw.busy} realTitle={sw.realTitle} onPick={sw.pick} onLinks={onLinks} onSettings={onSettings} />
      {open ? (
        <div
          class="netsheet"
          onClick={(e) => {
            if (e.target === e.currentTarget && !sw.busy) sw.dismiss();
          }}
        >
          <div class="netsheet__panel" role="dialog" aria-label="Real money">
            <NetPanel sw={sw} />
          </div>
        </div>
      ) : null}
    </>
  );
}
