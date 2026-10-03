/**
 * The link exists. The whole job of this screen is to get it to the other person: copy it, paste it
 * into the box on the page, or let them scan it. It says plainly what happens next, and what the
 * sender can do if nobody claims it.
 *
 * Clipboard rule: navigator.clipboard.writeText is only ever called directly inside a click handler.
 */
import { useEffect, useState } from "preact/hooks";
import { formatUsd } from "../../core";
import type { LinkRecord } from "../../lib/types";
import { ask } from "../api";
import { isReclaimable, pillOf } from "../../lib/links";
import { useApp } from "../context";
import { dayWords, plainSentence } from "../format";
import { useAlive, useFlash } from "../hooks";
import { IconCheck, IconCopy, IconPaste } from "../icons";
import { QrCode } from "../qr";
import { Button, CheckBadge, Heading, Notice } from "../ui";

/** Why a paste did not happen, in words (the worker names the cause in `how`). */
function whyNotPasted(how: string | undefined): string {
  switch (how) {
    case "no-focused-field":
    case "no-target":
      return "There's no text box to paste into. Click into one on the page first, then open Lumenia again.";
    case "inside-a-frame":
      return "That box is inside a frame we can't reach. Copy the link and paste it yourself.";
    case "read-only":
      return "That box can't be edited. Copy the link and paste it yourself.";
    case "not-a-text-field":
    case "not-editable":
      return "That isn't a text box. Click into one on the page first, then open Lumenia again.";
    default:
      return "We couldn't paste it there. Copy the link instead.";
  }
}

type PasteState = { kind: "idle" } | { kind: "busy" } | { kind: "done" } | { kind: "failed"; text: string };

export function LinkReady({
  record,
  link: given,
  inserted,
  onAnother,
}: {
  record: LinkRecord;
  link: string | null;
  inserted: boolean;
  onAnother: () => void;
}) {
  const { ws, refresh, records } = useApp();
  const alive = useAlive();
  const [link, setLink] = useState(given ?? "");
  const [revealProblem, setRevealProblem] = useState("");
  const [copied, flashCopied] = useFlash();
  const [copyFailed, setCopyFailed] = useState(false);
  const [paste, setPaste] = useState<PasteState>(inserted ? { kind: "done" } : { kind: "idle" });

  // Reopened onto a link we did not just make: the worker still holds it, ask for it.
  useEffect(() => {
    if (link) return;
    let live = true;
    void ask("links.reveal", { linkHex: record.linkHex }).then((r) => {
      if (!live) return;
      if (r.ok) setLink(r.data.link);
      else setRevealProblem(plainSentence(r.message) ?? "This browser no longer holds that link.");
    });
    return () => {
      live = false;
    };
  }, [link, record.linkHex]);

  function copyLink() {
    // First statement of the click handler: the browser requires the gesture to still be fresh.
    navigator.clipboard.writeText(link).then(
      () => {
        if (!alive.current) return;
        setCopyFailed(false);
        flashCopied();
        void ask("shared", { linkHex: record.linkHex, how: "copy" });
      },
      () => {
        if (alive.current) setCopyFailed(true);
      },
    );
  }

  async function pasteIntoPage() {
    setPaste({ kind: "busy" });
    const r = await ask("insert.run", { linkHex: record.linkHex });
    if (!alive.current) return;
    if (r.ok && r.data.inserted) {
      setPaste({ kind: "done" });
      void refresh(); // the worker has cleared the pending target
    } else {
      setPaste({ kind: "failed", text: r.ok ? whyNotPasted(r.data.how) : (plainSentence(r.message) ?? whyNotPasted(undefined)) });
    }
  }

  const real = record.net === "public";
  const ready = link !== "";
  const pasting = paste.kind === "busy";
  // The worker keeps reading the escrow, so this screen says what the latest reading says.
  const latest = records.find((r) => r.linkHex === record.linkHex) ?? record;
  const standing = pillOf(latest, Date.now());

  return (
    <main class="screen screen--ready">
      <div class="ready__head">
        <CheckBadge />
        <div>
          <Heading class="h1--ready">Your link is ready</Heading>
          <p class="ready__sub">
            <span class="money">{formatUsd(record.amount)}</span>
            {real ? " of real money" : " of practice money"}
          </p>
        </div>
      </div>

      {revealProblem ? <Notice tone="error">{revealProblem}</Notice> : null}

      <Button class="btn--copy" onClick={copyLink} disabled={!ready}>
        {copied ? <IconCheck /> : <IconCopy />}
        {copied ? "Copied" : "Copy link"}
      </Button>
      <span class="sr-only" role="status">
        {copied ? "Link copied" : ""}
      </span>

      {copyFailed ? (
        <div class="stack stack--tight">
          <Notice tone="error">Your browser wouldn't let us copy. Select the link below and copy it yourself.</Notice>
          <input
            class="field__input link-box"
            readOnly
            value={link}
            aria-label="The link"
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      ) : null}

      {paste.kind === "done" ? (
        <p class="pasted" role="status">
          <IconCheck />
          Pasted into the page
        </p>
      ) : (
        <Button variant="secondary" onClick={pasteIntoPage} busy={pasting} busyLabel="Pasting" disabled={!ready}>
          <IconPaste />
          Paste into the page
        </Button>
      )}
      {paste.kind === "failed" ? <Notice tone="error">{paste.text}</Notice> : null}
      {ws.pendingInsert && paste.kind !== "done" ? (
        <p class="fine fine--center">Pastes into the box you picked on {ws.pendingInsert.host || "the page"}.</p>
      ) : null}

      {ready ? (
        <figure class="qr-tile">
          <QrCode value={link} size={168} label="QR code of the link. Whoever scans it can claim the money." />
          <figcaption class="fine">Scan to open it on a phone. Anyone who scans it can claim the money.</figcaption>
        </figure>
      ) : null}

      <div class="ready__notes">
        {standing === "claimed" ? (
          <p>It was claimed.</p>
        ) : standing === "reclaimed" ? (
          <p>You took it back.</p>
        ) : (
          <>
            <p>Waiting to be claimed. The recipient pays no gas.</p>
            <p>
              {isReclaimable(latest, Date.now())
                ? "Nobody claimed it. You can take it back from Links."
                : `If nobody claims it by ${dayWords(record.expiry)}, you can take it back.`}
            </p>
            {record.locked ? <p>They'll need the password you set.</p> : null}
          </>
        )}
      </div>

      <Button variant="quiet" onClick={onAnother} class="btn--another">
        Make another link
      </Button>
    </main>
  );
}
