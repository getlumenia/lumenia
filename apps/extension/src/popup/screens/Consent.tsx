/**
 * First run: what leaves this browser, and when, said before anything does. Agreeing is stored by
 * the worker (consent.agree); until then it refuses every request that would reach a server.
 */
import { useState } from "preact/hooks";
import { URLS } from "../../config";
import { DISCLOSE_EMAIL_KEPT, DISCLOSE_PILOT_ASK, DISCLOSE_PILOT_CHECK, disclosureParts } from "../../lib/copy";
import { ask } from "../api";
import { useApp } from "../context";
import { plainSentence } from "../format";
import { BrandBar, Button, ExtLink, Heading, Mascot, Notice } from "../ui";

export function Consent() {
  const { applyState } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function agree() {
    setBusy(true);
    setError("");
    const r = await ask("consent.agree");
    setBusy(false);
    if (r.ok) applyState(r.data);
    else setError(plainSentence(r.message) ?? "We couldn't save that. Try again.");
  }

  return (
    <>
      <BrandBar />
      <main class="screen">
        <div class="beat beat--row">
          <Mascot pose="thumbsup" size="sm" />
          <div class="beat__text">
            <Heading>One thing first</Heading>
            <p class="lede">Here is what leaves this browser, and when.</p>
          </div>
        </div>
        {/* Short enough to read in one screen with the button in view: every item names what is
            sent, to whom and why, and the privacy policy carries the rest. */}
        <ul class="facts facts--tight">
          <li>
            <strong>Back up or restore:</strong> your email, a one-time code and your locked key, to Lumenia.
          </li>
          <li>
            <strong>Send or take back:</strong> the transfer you signed, so Lumenia can pay the fee. Other checks send only your public
            key.
          </li>
          {/* The real-money sentences are the ones every surface uses, word for word (lib/copy.ts). */}
          <Disclosure sentence={DISCLOSE_PILOT_CHECK} />
          <Disclosure sentence={DISCLOSE_PILOT_ASK} />
          <li>
            <strong>Counting:</strong> event names like "link created" with one-way hashes. Never a web address, a link's secret or page
            content.
          </li>
          <li>
            <strong>Servers:</strong> ours see your IP address, for rate limits. Public Stellar servers see the account or link you look
            up.
          </li>
          <li>
            <strong>On this device:</strong> your key, locked with your password, and your links, encrypted.
          </li>
          <Disclosure sentence={DISCLOSE_EMAIL_KEPT} />
        </ul>
        <div class="screen__spacer" />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button onClick={agree} busy={busy} busyLabel="One moment">
          Agree and continue
        </Button>
        <p class="fine fine--center">
          <ExtLink href={URLS.privacy}>Privacy policy</ExtLink>. Nothing is sent until you agree.
        </p>
      </main>
    </>
  );
}

/** One shared disclosure sentence, its label in bold. */
function Disclosure({ sentence }: { sentence: string }) {
  const { label, rest } = disclosureParts(sentence);
  return (
    <li>
      <strong>{label}</strong> {rest}
    </li>
  );
}
