/**
 * Every link made in this browser, newest first, and what became of each. The list is read from the
 * worker's own records, never guessed: a status here is a status the ledger confirmed, and anything
 * we could not confirm says so in words instead of picking a side.
 *
 * Rows are kept honest by the worker's settle loop; the popup repaints whenever a record changes.
 */
import { useEffect, useState } from "preact/hooks";
import { netConfig } from "../../config";
import { explorerTxOn, formatUsd } from "../../core";
import { isReclaimable, PILL_LABEL, pillOf, sortRecords } from "../../lib/links";
import type { LinkRecord, Pill } from "../../lib/types";
import { ask } from "../api";
import { useApp } from "../context";
import { useEscape } from "../escape";
import { dayWords, plainSentence, when } from "../format";
import { useAlive, useFlash, useNow } from "../hooks";
import { IconCheck, IconCopy, IconExternal, IconLock } from "../icons";
import { Button, Mascot, Spinner, openUrl } from "../ui";

export function Links() {
  const { records, setRecords, reloadRecords } = useApp();
  const alive = useAlive();
  const now = useNow();
  const [checking, setChecking] = useState(true);

  // Paint what the worker already holds, and ask it to look at the ledger once, at the same time.
  useEffect(() => {
    void reloadRecords();
    void ask("links.refresh").then((r) => {
      if (!alive.current) return;
      if (r.ok) setRecords(sortRecords(r.data));
      setChecking(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (records.length === 0) {
    return (
      <main class="screen screen--center">
        <div class="empty">
          <Mascot pose="wave" size="md" />
          <h2 class="h2">No links yet</h2>
          <p class="lede lede--center">Links you make here are listed here. Links made on getlumenia.com stay there.</p>
          {checking ? (
            <p class="fine fine--center">
              <Spinner /> Looking for links
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  return (
    <main class="screen screen--list">
      <ul class="rows" aria-label="Your links">
        {records.map((r) => (
          <LinkRow key={r.linkHex} record={r} now={now} />
        ))}
      </ul>
    </main>
  );
}

const PILL_CLASS: Record<Pill, string> = {
  waiting: "pill pill--waiting",
  reclaimable: "pill pill--reclaimable",
  claimed: "pill pill--claimed",
  reclaimed: "pill pill--reclaimed",
  closed: "pill pill--closed",
  uncertain: "pill pill--uncertain",
  checking: "pill pill--checking",
  failed: "pill pill--failed",
};

/** A link someone can still use: confirmed and not claimed or taken back. */
const isLive = (r: LinkRecord): boolean => r.phase === "confirmed" && r.status === "pending";

function LinkRow({ record: r, now }: { record: LinkRecord; now: number }) {
  const { setRecords, records } = useApp();
  const alive = useAlive();
  const pill = pillOf(r, now);
  const reclaimable = isReclaimable(r, now);
  const [copied, flashCopied] = useFlash();
  const [copyBusy, setCopyBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [reclaiming, setReclaiming] = useState(false);
  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  useEscape(() => {
    if (!confirming) return false;
    setConfirming(false);
    return true;
  });

  async function copyLink() {
    setMessage(null);
    setCopyBusy(true);
    const got = await ask("links.reveal", { linkHex: r.linkHex });
    if (!alive.current) return;
    if (!got.ok) {
      setCopyBusy(false);
      setMessage({ tone: "error", text: plainSentence(got.message) ?? "This browser no longer holds that link." });
      return;
    }
    try {
      await navigator.clipboard.writeText(got.data.link);
      if (!alive.current) return;
      flashCopied();
      void ask("shared", { linkHex: r.linkHex, how: "copy" });
    } catch {
      if (alive.current) setMessage({ tone: "error", text: "Your browser wouldn't let us copy. Open the link from the screen you made it on." });
    }
    if (alive.current) setCopyBusy(false);
  }

  function viewTransaction() {
    try {
      openUrl(explorerTxOn(netConfig(r.net), r.hash ?? r.innerHash));
    } catch {
      setMessage({ tone: "error", text: "We couldn't open that page." });
    }
  }

  async function takeBack() {
    setReclaiming(true);
    setMessage(null);
    const res = await ask("links.reclaim", { linkHex: r.linkHex });
    if (!alive.current) return;
    setReclaiming(false);
    setConfirming(false);
    if (res.ok) {
      setRecords(sortRecords(records.map((x) => (x.linkHex === res.data.linkHex ? res.data : x))));
      setMessage({ tone: "info", text: `${formatUsd(r.amount)} is back in your account.` });
    } else {
      setMessage({
        tone: res.code === "uncertain" ? "info" : "error",
        text: plainSentence(res.message) ?? "We couldn't take it back just now. Try again in a moment.",
      });
    }
  }

  const canViewTx = r.phase === "confirmed";

  return (
    <li class={`row-card row-card--${pill}`}>
      <div class="row-card__top">
        <div class="row-card__amount">
          <span class="money row-card__usd">{formatUsd(r.amount)}</span>
          {r.net === "public" ? <span class="tag">Real money</span> : null}
        </div>
        <span class={PILL_CLASS[pill]}>
          {pill === "claimed" ? <IconCheck /> : <span class="pill__dot" aria-hidden="true" />}
          {PILL_LABEL[pill]}
        </span>
      </div>

      <p class="row-card__meta">
        <span>{when(r.createdAt)}</span>
        {r.locked ? (
          <span class="row-card__lock">
            <IconLock /> Password set
          </span>
        ) : null}
      </p>

      <p class="row-card__note">{noteFor(r, pill)}</p>

      {message ? (
        <p class={message.tone === "error" ? "row-card__msg row-card__msg--error" : "row-card__msg"} role={message.tone === "error" ? "alert" : "status"}>
          {message.text}
        </p>
      ) : null}

      {confirming ? (
        <div class="confirm" role="group" aria-label="Take it back">
          <p class="confirm__text">
            Take <span class="money">{formatUsd(r.amount)}</span> back to your account? The link stops working once you do.
          </p>
          <div class="row">
            <Button small onClick={takeBack} busy={reclaiming} busyLabel="Taking it back">
              Take it back
            </Button>
            <Button small variant="secondary" onClick={() => setConfirming(false)} disabled={reclaiming}>
              Keep waiting
            </Button>
          </div>
        </div>
      ) : (
        <div class="row-card__actions">
          {isLive(r) ? (
            <Button small variant="secondary" onClick={copyLink} busy={copyBusy} busyLabel="Copy">
              {copied ? <IconCheck /> : <IconCopy />}
              {copied ? "Copied" : "Copy"}
            </Button>
          ) : null}
          {canViewTx ? (
            <Button small variant="secondary" onClick={viewTransaction}>
              <IconExternal />
              View transaction
            </Button>
          ) : null}
          {reclaimable ? (
            <Button small variant="secondary" onClick={() => setConfirming(true)}>
              Take it back
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}

/** One sentence on where a link stands, never more than is known. */
function noteFor(r: LinkRecord, pill: Pill): string {
  switch (pill) {
    case "uncertain":
      return "Sent, not confirmed yet. Don't send it again; we keep checking.";
    case "checking":
      return "Being made. This usually takes a few seconds.";
    case "failed":
      return r.failReason ?? "It did not go through. Nothing moved, so you can send it again.";
    case "claimed":
      return "It was claimed.";
    case "reclaimed":
      return "You took it back.";
    case "closed":
      return "It was claimed, or your take-back went through. We can't tell which from here; your balance shows it.";
    case "reclaimable":
      return "Nobody claimed it. Take it back now: until you do, whoever has the link can still claim it.";
    case "waiting":
      return `Waiting to be claimed. You can take it back from ${dayWords(r.expiry)}.`;
  }
}
