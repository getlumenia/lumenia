/**
 * The two readings the Send screen shows next to the form: the balance, and (on real money only)
 * where the account stands in the pilot.
 */
import { useCallback, useEffect, useState } from "preact/hooks";
import { PILOT_CACHE_MS } from "../config";
import type { BalanceInfo, NetId, PilotInfo, WorkerState } from "../lib/types";
import { ask } from "./api";
import { useAlive } from "./hooks";

export type BalanceView = { state: "loading" } | { state: "ready"; info: BalanceInfo } | { state: "unreadable" };

/** A balance answer is either readable, or the account is missing, or we could not read it at all. */
const classify = (info: BalanceInfo): BalanceView =>
  info.usd === null && !info.missing ? { state: "unreadable" } : { state: "ready", info };

/** The balance on the money in use. Reads again when the money changes or `reload` is called. */
export function useBalance(net: NetId): { view: BalanceView; reload: () => void; set: (info: BalanceInfo) => void } {
  const [view, setView] = useState<BalanceView>({ state: "loading" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setView({ state: "loading" });
    void ask("balance").then((r) => {
      if (!live) return;
      setView(r.ok ? classify(r.data) : { state: "unreadable" });
    });
    return () => {
      live = false;
    };
  }, [net, round]);

  const reload = useCallback(() => setRound((n) => n + 1), []);
  const set = useCallback((info: BalanceInfo) => setView(classify(info)), []);
  return { view, reload, set };
}

// The worker meters the pilot question in the same per-account bucket as a send, so the popup asks
// at most once a minute however many screens want the answer.
let lastPilotAsk = 0;

/**
 * The pilot standing of this account: what the worker has cached, refreshed when it is older than
 * a minute and the money in use is real. Never asked on practice money, never on every render.
 */
export function usePilot(ws: WorkerState): PilotInfo | null {
  const [info, setInfo] = useState<PilotInfo | null>(ws.pilot);
  const pubkey = ws.account?.pubkey ?? null;
  const alive = useAlive();

  useEffect(() => {
    setInfo((cur) => (ws.pilot && (!cur || ws.pilot.at >= cur.at) ? ws.pilot : cur));
  }, [ws.pilot]);

  useEffect(() => {
    if (ws.settings.net !== "public" || !pubkey) return;
    const age = ws.pilot ? Date.now() - ws.pilot.at : Number.POSITIVE_INFINITY;
    if (age <= PILOT_CACHE_MS) return;
    if (Date.now() - lastPilotAsk < PILOT_CACHE_MS) return;
    lastPilotAsk = Date.now();
    void ask("pilot.status").then((r) => {
      if (alive.current && r.ok && r.data) setInfo(r.data);
    });
  }, [ws.settings.net, pubkey, ws.pilot]);

  return info;
}
