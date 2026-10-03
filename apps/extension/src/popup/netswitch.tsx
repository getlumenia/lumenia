/**
 * Which money the popup uses, and the one way to change it: the switch that is always in the header,
 * and the same switch in Settings. Both run the logic below, so the two can never disagree.
 *
 * Practice money is one tap. Real money keeps its ceremony, because it is the one switch with
 * consequences: the pilot is asked first (forced, so the answer is fresh), an account that is not on
 * the list hears "invite-only", the early-preview note is shown once and waits for "I understand",
 * and only then does the worker change the money. The worker checks all of it again (router.ts,
 * network.set), so a popup that skipped a step still could not switch.
 */
import { useState } from "preact/hooks";
import { DAY_CAP_USD, TX_CAP_USD, URLS } from "../config";
import { formatUsd } from "../core";
import type { NetId, PilotInfo } from "../lib/types";
import { ask } from "./api";
import { useApp } from "./context";
import { useEscape } from "./escape";
import { plainSentence } from "./format";
import { useAlive } from "./hooks";
import { Button, ExtLink, Notice, TopBar } from "./ui";

export type NetUi =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "invite-only" }
  | { kind: "warning" }
  | { kind: "switching"; to: NetId }
  | { kind: "error"; text: string; web?: boolean };

const WARNING =
  "Real money is an early preview. It hasn't been reviewed by an outside security firm yet, so keep amounts tiny.";

export interface NetSwitchState {
  net: NetId;
  ui: NetUi;
  /** a check or a switch is running: the switch takes no second tap */
  busy: boolean;
  /** the pilot answer the last real-money check got, for the "sends left" line */
  checked: PilotInfo | null;
  pick: (target: NetId) => void;
  understand: () => void;
  dismiss: () => void;
}

export function useNetSwitch(): NetSwitchState {
  const { ws, refresh } = useApp();
  const alive = useAlive();
  const [ui, setUi] = useState<NetUi>({ kind: "idle" });
  const [checked, setChecked] = useState<PilotInfo | null>(null);
  const net = ws.settings.net;
  const busy = ui.kind === "checking" || ui.kind === "switching";

  async function switchTo(target: NetId): Promise<void> {
    setUi({ kind: "switching", to: target });
    const r = await ask("network.set", { net: target });
    if (!alive.current) return;
    if (!r.ok) {
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
    setUi({ kind: "checking" });
    const p = await ask("pilot.status", { force: true });
    if (!alive.current) return;
    if (!p.ok || !p.data) {
      setUi({ kind: "error", text: (!p.ok && plainSentence(p.message)) || "We couldn't check right now. Try again in a moment." });
      return;
    }
    setChecked(p.data);
    if (!p.data.approved) {
      setUi({ kind: "invite-only" });
      return;
    }
    if (p.data.limit > 0 && p.data.used >= p.data.limit) {
      setUi({ kind: "error", text: "You've used all your real-money sends in the pilot. Practice money still works." });
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
    pick: (target) => {
      if (busy || target === net) return;
      void (target === "public" ? chooseReal() : switchTo("testnet"));
    },
    understand: () => void understandNote(),
    dismiss: () => setUi({ kind: "idle" }),
  };
}

/** What the switch has to say, when it has something to say: the check, the answer, the note. */
export function NetPanel({ sw }: { sw: NetSwitchState }) {
  const { ui, checked } = sw;
  switch (ui.kind) {
    case "checking":
      return (
        <p class="fine" role="status">
          Checking your access to real money
        </p>
      );
    case "switching":
      return (
        <p class="fine" role="status">
          {ui.to === "public" ? "Switching to real money" : "Switching to practice money"}
        </p>
      );
    case "invite-only":
      return (
        <>
          <Notice>
            <strong>Real money is invite-only for now.</strong> This account isn't on the list yet.{" "}
            <ExtLink href={URLS.pilot} class="nowrap">
              Ask to join
            </ExtLink>
          </Notice>
          <div class="row">
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
          <p>{WARNING}</p>
          <p>
            Links are capped at {formatUsd(TX_CAP_USD)} each and {formatUsd(DAY_CAP_USD)} a day
            {checked && checked.pilot && checked.limit > 0 ? `, and this account has ${Math.max(0, checked.limit - checked.used)} of ${checked.limit} sends left` : ""}.
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
      <TopBar net={sw.net} switchDisabled={busy || sw.busy} onPick={sw.pick} onLinks={onLinks} onSettings={onSettings} />
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
