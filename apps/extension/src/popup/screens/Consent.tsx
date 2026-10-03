/**
 * First run: what leaves this browser, and when, said before anything does. Agreeing is stored by
 * the worker (consent.agree); until then it refuses every request that would reach a server.
 */
import { useState } from "preact/hooks";
import { URLS } from "../../config";
import { ask } from "../api";
import { useApp } from "../context";
import { plainSentence } from "../format";
import { BrandBar, Button, ExtLink, Heading, Notice } from "../ui";

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
        <Heading>Before you start</Heading>
        <p class="lede">Here is what leaves this browser, and when.</p>
        <ul class="facts">
          <li>
            <strong>To restore your account.</strong> We send your email address and a one-time code to Lumenia's server.
          </li>
          <li>
            <strong>When you send or take back.</strong> The signed transfer goes to Lumenia's server, which pays the network
            fee. A practice top-up sends your public key.
          </li>
          <li>
            <strong>Real money only.</strong> Your public key, to check whether the pilot approved your account.
          </li>
          <li>
            <strong>Counting.</strong> A few usage counts, like "link created": an event name and one-way hashes, never a web
            address, a link's secret or page content.
          </li>
          <li>
            <strong>Servers.</strong> Lumenia's servers see your IP address, for rate limits. Public Stellar servers supply
            balances and link status, and see the account or link asked about.
          </li>
          <li>
            <strong>On this device.</strong> Your key is stored here, encrypted with your password. Your links stay in this browser,
            each full link encrypted with your key.
          </li>
        </ul>
        <div class="screen__spacer" />
        {error ? <Notice tone="error">{error}</Notice> : null}
        <Button onClick={agree} busy={busy} busyLabel="One moment">
          Agree and continue
        </Button>
        <p class="fine fine--center">
          <ExtLink href={URLS.privacy}>Privacy policy</ExtLink>. If you'd rather not, just close this window. Nothing is sent until you
          agree.
        </p>
      </main>
    </>
  );
}
