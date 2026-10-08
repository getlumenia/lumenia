/**
 * The shell. It owns what the worker said (state, link records), which screen that means, and the
 * send flow while the popup is open. Everything else is a screen that asks the shell for little.
 *
 * The router is a pure reading of WorkerState: consent first, then host access (Firefox), then no
 * account (connect / restore), then locked, then the home screens. The popup keeps only what the
 * worker cannot know: the form, which of Links / Settings is open, and a send in flight.
 *
 * One rule about reading state: `state` counts as activity in the worker (it pushes the auto-lock
 * back), so it is read after things the person did, never on a timer while they are idle.
 */
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { URLS } from "../config";
import { holdOpen, onLinksChanged } from "../lib/client";
import { sortRecords } from "../lib/links";
import type { LinkRecord, SendOutcome, WorkerState } from "../lib/types";
import { ask, onStale } from "./api";
import { AppCtx, type AppApi, type View } from "./context";
import { runEscape } from "./escape";
import { EMPTY_DRAFT, type Draft, type Flow, type FormError, recentReady } from "./flow";
import { plainSentence } from "./format";
import { sleep } from "./hooks";
import { describeProblem, type Problem } from "./problems";
import { Backup } from "./screens/Backup";
import { Choose } from "./screens/Choose";
import { Consent } from "./screens/Consent";
import { Create } from "./screens/Create";
import { Created } from "./screens/Created";
import { Hello } from "./screens/Hello";
import { HostAccess } from "./screens/HostAccess";
import { LinkReady } from "./screens/LinkReady";
import { Links } from "./screens/Links";
import { ProblemPanel } from "./screens/ProblemPanel";
import { RestoreCode, RestoreEmail, RestorePassword } from "./screens/Restore";
import { SendForm, type SendInput } from "./screens/Send";
import { Sending } from "./screens/Sending";
import { Settings } from "./screens/Settings";
import { Unlock } from "./screens/Unlock";
import { NetHeader } from "./netswitch";
import { BrandBar, Button, Notice, SubBar, openUrl } from "./ui";
// A link the person has already moved past ("Make another link") is not offered again on reopen.
import { readDismissed, writeDismissed } from "./local";


/** How long the popup waits for a send it lost sight of before it stops and points at Links. */
const SETTLE_WAIT_MS = 100_000;

export function App() {
  const [ws, setWs] = useState<WorkerState | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  const [records, setRecordsState] = useState<LinkRecord[]>([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [view, setView] = useState<View>("home");
  /** before an account exists: the account question, the restore steps, or a new account's password */
  const [guest, setGuest] = useState<"choose" | "email" | "create">("choose");
  /** first run: the hello screen was passed (the agreement comes next) */
  const [started, setStarted] = useState(false);
  /** an account was just made here: the "you're in" beat shows once */
  const [fresh, setFresh] = useState(false);
  const [flow, setFlow] = useState<Flow>({ kind: "form" });
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState<FormError | null>(null);

  const alive = useRef(true);
  const live = useRef({ ws, view, flow, guest });
  live.current = { ws, view, flow, guest };

  /* ----------------------------------- reading the worker ----------------------------------- */

  const refresh = useCallback(async (): Promise<WorkerState | null> => {
    const r = await ask("state");
    if (!alive.current) return null;
    if (!r.ok) {
      setUnreachable(true);
      return null;
    }
    setUnreachable(false);
    setWs(r.data);
    if (!r.data.unlocked) setView((v) => (v === "links" ? "home" : v));
    return r.data;
  }, []);

  const reloadRecords = useCallback(async (): Promise<void> => {
    const r = await ask("links.list");
    if (!alive.current || !r.ok) return;
    setRecordsState(sortRecords(r.data));
    setRecordsLoaded(true);
  }, []);

  const setRecords = useCallback((rs: LinkRecord[]) => setRecordsState(sortRecords(rs)), []);

  // Open: keep the worker awake while the popup is visible, read its state, follow the link list live.
  useEffect(() => {
    alive.current = true;
    const release = holdOpen();
    void refresh();
    const unwatch = onLinksChanged(() => void reloadRecords());
    const unstale = onStale(() => void refresh());
    return () => {
      alive.current = false;
      release();
      unwatch();
      unstale();
    };
  }, [refresh, reloadRecords]);

  const pubkey = ws?.account?.pubkey ?? null;
  useEffect(() => {
    if (!pubkey) {
      setRecordsState([]);
      setRecordsLoaded(false);
      return;
    }
    void reloadRecords();
  }, [pubkey, reloadRecords]);

  // The session locks itself; show the lock the moment it happens instead of on the next click.
  // Read just AFTER lockAt, so this read can never be the thing that extends it.
  useEffect(() => {
    if (!ws?.unlocked || !ws.lockAt) return;
    const wait = Math.max(1500, ws.lockAt - Date.now() + 1500);
    const t = window.setTimeout(() => void refresh(), wait);
    return () => window.clearTimeout(t);
  }, [ws?.unlocked, ws?.lockAt, refresh]);

  /* ----------------------------------- where to open ----------------------------------- */

  // Once per unlock: a send still running, or a link made in the last few minutes, comes back up.
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!ws?.account || !ws.unlocked) {
      opened.current = null;
      return;
    }
    if (opened.current === ws.account.pubkey || !recordsLoaded) return;
    opened.current = ws.account.pubkey;
    if (ws.sending) {
      setFlow({ kind: "sending", amount: null, startedAt: ws.sending.startedAt });
      void settleAfterSend(ws.sending.startedAt);
      return;
    }
    const ready = recentReady(records, Date.now());
    if (ready && ready.linkHex !== readDismissed()) {
      setFlow({ kind: "ready", record: ready, link: null, inserted: Boolean(ready.insertedAt) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, recordsLoaded]);

  // Another money, another screen: a ready link or a refusal from the money just left would sit under
  // the wrong switch, so the home screen goes back to the form. A send in progress keeps its screen
  // (the switch is disabled while it runs).
  const netNow = ws?.settings.net ?? null;
  const lastNet = useRef(netNow);
  useEffect(() => {
    if (lastNet.current !== null && netNow !== null && lastNet.current !== netNow) {
      setFlow((f) => (f.kind === "sending" ? f : { kind: "form" }));
    }
    lastNet.current = netNow;
  }, [netNow]);

  /* ----------------------------------- making a link ----------------------------------- */

  /**
   * A send the popup lost sight of (it was closed and reopened, or the worker restarted under it):
   * wait for the worker to finish, then read what happened from the records, which are written
   * BEFORE the transfer is posted. Nothing here ever sends again.
   */
  const settleAfterSend = useCallback(
    async (startedAt: number, why?: string): Promise<void> => {
      const deadline = Date.now() + SETTLE_WAIT_MS;
      let stillSending = false;
      let since = startedAt; // a send that began before this one (the worker said busy) is the one to read
      for (;;) {
        const s = await ask("state");
        if (!alive.current) return;
        if (s.ok) {
          setWs(s.data);
          stillSending = Boolean(s.data.sending);
          if (s.data.sending) since = Math.min(since, s.data.sending.startedAt);
        }
        if (s.ok && !stillSending) break;
        if (Date.now() > deadline) break;
        await sleep(1500);
        if (!alive.current) return;
      }
      const l = await ask("links.list");
      const recs = l.ok ? sortRecords(l.data) : [];
      if (!alive.current) return;
      if (l.ok) {
        setRecordsState(recs);
        setRecordsLoaded(true);
      }
      const net = live.current.ws?.settings.net ?? "testnet";
      const mine = recs.find((r) => r.createdAt >= since - 2000);

      if (!mine) {
        setFlow({
          kind: "problem",
          problem: stillSending
            ? {
                code: "busy",
                title: "Still working on it",
                body: "This one is taking longer than usual. It will show up in Links when it's done.",
                action: "links",
                label: "See links",
              }
            : {
                code: "internal",
                title: "That didn't finish",
                body: plainSentence(why) ?? "Something went wrong before anything was sent. Try again.",
                action: "back",
                label: "Back",
              },
        });
        return;
      }
      if (mine.phase === "confirmed") {
        setDraft((d) => ({ ...d, amount: "", password: "" }));
        setFlow({ kind: "ready", record: mine, link: null, inserted: Boolean(mine.insertedAt) });
      } else if (mine.phase === "failed") {
        setFlow({
          kind: "problem",
          problem: {
            code: "sponsor-refused",
            title: "It didn't go through",
            body: mine.failReason ?? "It did not go through. Nothing moved, so you can send it again.",
            action: "back",
            label: "Back",
          },
        });
      } else {
        setFlow({ kind: "problem", problem: describeProblem("uncertain", "", net) });
      }
      void refresh();
    },
    [refresh],
  );

  const sent = useCallback(
    (o: SendOutcome) => {
      if (o.record.phase === "confirmed") {
        setDraft((d) => ({ ...d, amount: "", password: "" }));
        setFlow({ kind: "ready", record: o.record, link: o.link ?? null, inserted: Boolean(o.inserted) });
      } else {
        setFlow({ kind: "problem", problem: describeProblem("uncertain", "", o.record.net) });
      }
      void reloadRecords();
      void refresh();
    },
    [reloadRecords, refresh],
  );

  const startSend = useCallback(
    async (input: SendInput): Promise<void> => {
      const startedAt = Date.now();
      const net = live.current.ws?.settings.net ?? "testnet";
      setFormError(null);
      setFlow({ kind: "sending", amount: input.amount, startedAt });
      if (input.from !== (live.current.ws?.settings.from ?? "")) {
        await ask("settings.set", { patch: { from: input.from } });
      }
      const r = await ask("send", {
        amount: input.amount,
        from: input.from,
        ...(input.password ? { password: input.password } : {}),
        ...(input.anyway ? { anyway: true as const } : {}),
      });
      if (!alive.current) return;
      if (r.ok) {
        sent(r.data);
        return;
      }
      switch (r.code) {
        case "internal": // the worker went away under us: read what it left, do not call it a failure
        case "busy":
          await settleAfterSend(startedAt, r.message);
          return;
        case "locked":
        case "needs-consent":
        case "no-account":
        case "host-access": {
          // The worker's state decides the screen (Unlock, Consent, Connect, host access). Only if it
          // still reads as ready to send do we say what happened, so the person is never left guessing.
          const next = await refresh();
          const rerouted =
            next !== null && (next.settings.consentAt === null || !next.hostAccess || !next.account || !next.unlocked);
          setFlow(rerouted ? { kind: "form" } : { kind: "problem", problem: describeProblem(r.code, r.message, net) });
          return;
        }
        case "bad-amount":
          setFlow({ kind: "form" });
          setFormError({ field: "amount", text: plainSentence(r.message) ?? "Enter an amount, like 5 or 2.50." });
          return;
        case "weak-link-password":
          setFlow({ kind: "form" });
          setFormError({ field: "password", text: plainSentence(r.message) ?? "Pick a stronger password for the link." });
          return;
        case "open-send":
          // The worker knows of an unconfirmed send this popup had not loaded yet. Back to the form,
          // which now shows it and asks before a new one.
          setFlow({ kind: "form" });
          await reloadRecords();
          return;
        default:
          setFlow({ kind: "problem", problem: describeProblem(r.code, r.message, net) });
          void reloadRecords();
      }
    },
    [refresh, reloadRecords, sent, settleAfterSend],
  );

  const problemAction = useCallback(
    async (p: Problem): Promise<void> => {
      const back = () => setFlow({ kind: "form" });
      switch (p.action) {
        case "back":
          back();
          return;
        case "links":
          back();
          setView("links");
          return;
        case "join":
          openUrl(URLS.pilot);
          return;
        case "web-settings":
          openUrl(URLS.settings);
          return;
        case "settings":
          back();
          setView("settings");
          return;
        case "backup":
          back();
          setView("backup");
          return;
        case "refresh":
          back();
          await refresh();
          return;
        case "use-practice": {
          await ask("network.set", { net: "testnet" });
          back();
          await refresh();
          return;
        }
        case "practice": {
          const r = await ask("testmoney");
          if (!alive.current) return;
          if (r.ok) {
            back();
          } else {
            setFlow({
              kind: "problem",
              problem: {
                code: "sponsor-refused",
                title: "No practice dollars yet",
                body: plainSentence(r.message) ?? "We couldn't get practice dollars just now. Try again in a moment.",
                action: "back",
                label: "Back",
              },
            });
          }
          return;
        }
      }
    },
    [refresh],
  );

  const makeAnother = useCallback(
    (linkHex: string) => {
      writeDismissed(linkHex);
      setFlow({ kind: "form" });
      void reloadRecords();
    },
    [reloadRecords],
  );

  const cancelInsert = useCallback(async () => {
    await ask("insert.cancel");
    await refresh();
  }, [refresh]);

  /* ----------------------------------- keys ----------------------------------- */

  // Escape goes back one screen, and closes the popup from the home screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (runEscape()) {
        e.preventDefault();
        return;
      }
      const { view: v, flow: f } = live.current;
      e.preventDefault();
      if (!live.current.ws?.account && live.current.guest !== "choose") setGuest("choose");
      else if (v !== "home") setView("home");
      else if (f.kind === "problem") setFlow({ kind: "form" });
      else window.close();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  /* ----------------------------------- render ----------------------------------- */

  const api = useMemo<AppApi | null>(
    () =>
      ws
        ? {
            ws,
            net: ws.settings.net,
            records,
            refresh,
            applyState: setWs,
            reloadRecords,
            setRecords,
            go: setView,
            startRestore: () => setGuest("email"),
            leaveRestore: () => setGuest("choose"),
            startCreate: () => setGuest("create"),
            justCreated: () => setFresh(true),
          }
        : null,
    [ws, records, refresh, reloadRecords, setRecords],
  );

  /** What the home route shows: the form, a send in progress, a link that is ready, or a refusal. */
  const renderHome = (): ComponentChildren => {
    switch (flow.kind) {
      case "sending":
        return <Sending amount={flow.amount} startedAt={flow.startedAt} />;
      case "ready":
        return (
          <LinkReady
            key={flow.record.linkHex}
            record={flow.record}
            link={flow.link}
            inserted={flow.inserted}
            onAnother={() => makeAnother(flow.record.linkHex)}
          />
        );
      case "problem":
        return <ProblemPanel key={flow.problem.code + flow.problem.title} problem={flow.problem} onAction={() => problemAction(flow.problem)} />;
      default:
        return (
          // Keyed by the money: switching remounts the form with that money's defaults (on real money
          // the name and link-password section opens, because its password is on).
          <SendForm
            key={ws?.settings.net ?? "testnet"}
            draft={draft}
            patch={(p) => setDraft((d) => ({ ...d, ...p }))}
            formError={formError}
            setFormError={setFormError}
            onSend={(input) => void startSend(input)}
            onCancelInsert={() => void cancelInsert()}
          />
        );
    }
  };

  /** The router: a plain reading of what the worker said, in the order things have to be true. */
  const renderScreen = (w: WorkerState): ComponentChildren => {
    if (w.settings.consentAt === null) return started ? <Consent /> : <Hello onStart={() => setStarted(true)} />;
    if (!w.hostAccess) return <HostAccess />;

    if (!w.account) {
      if (w.restore) return w.restore.step === "code" ? <RestoreCode /> : <RestorePassword />;
      if (guest === "email") return <RestoreEmail />;
      if (guest === "create") return <Create />;
      return <Choose />;
    }

    if (!w.unlocked) {
      if (view === "settings") {
        return (
          <>
            <SubBar title="Settings" onBack={() => setView("home")} />
            <Settings locked />
          </>
        );
      }
      return <Unlock />;
    }

    if (fresh) return <Created onDone={() => setFresh(false)} />;

    if (view === "links") {
      return (
        <>
          <SubBar title="Links" onBack={() => setView("home")} />
          <Links />
        </>
      );
    }
    if (view === "backup") {
      return (
        <>
          <SubBar title="Back up" onBack={() => setView("home")} />
          <Backup />
        </>
      );
    }
    if (view === "settings") {
      return (
        <>
          <SubBar title="Settings" onBack={() => setView("home")} />
          <Settings />
        </>
      );
    }

    return (
      <>
        <NetHeader busy={flow.kind === "sending"} onLinks={() => setView("links")} onSettings={() => setView("settings")} />
        {renderHome()}
      </>
    );
  };

  if (!ws || !api) {
    return (
      <>
        <BrandBar />
        <main class="screen screen--center">
          {unreachable ? (
            <div class="empty">
              <Notice tone="error">The extension did not answer. Close this window and open it again, or try once more.</Notice>
              <Button variant="secondary" onClick={() => void refresh()}>
                Try again
              </Button>
            </div>
          ) : null}
        </main>
      </>
    );
  }

  return <AppCtx.Provider value={api}>{renderScreen(ws)}</AppCtx.Provider>;
}
