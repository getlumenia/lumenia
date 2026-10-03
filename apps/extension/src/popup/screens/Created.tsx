/**
 * The beat after a new account: the messenger celebrates, and practice dollars are added on the
 * spot (the account is opened on the practice network and the faucet pays it), so the very first
 * link can be made from the next screen. The account exists only in this browser until it is
 * backed up; that is said here once, with the way to do it, and again on the Send screen.
 */
import { useEffect, useState } from "preact/hooks";
import { formatUsd } from "../../core";
import { ask } from "../api";
import { useApp } from "../context";
import { plainSentence } from "../format";
import { useAlive } from "../hooks";
import { BrandBar, Button, Heading, Mascot, Spinner } from "../ui";

type Funding = { state: "adding" } | { state: "added"; usd: string | null } | { state: "failed"; why: string } | { state: "skipped" };

export function Created({ onDone }: { onDone: () => void }) {
  const { ws, net, go } = useApp();
  const alive = useAlive();
  const [funding, setFunding] = useState<Funding>(() => (net === "testnet" ? { state: "adding" } : { state: "skipped" }));

  useEffect(() => {
    if (net !== "testnet") return;
    void ask("testmoney").then((r) => {
      if (!alive.current) return;
      setFunding(r.ok ? { state: "added", usd: r.data.usd } : { state: "failed", why: plainSentence(r.message) ?? "We couldn't add practice dollars just now." });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <BrandBar />
      <main class="screen screen--beat" aria-live="polite">
        <Mascot pose="celebrate" size="lg" label />
        <Heading class="h1--center">You're in!</Heading>
        <p class="lede lede--center">
          {funding.state === "adding" ? (
            <>
              <Spinner /> Adding practice dollars so you can try it.
            </>
          ) : funding.state === "added" ? (
            <>
              You have <span class="money">{formatUsd(funding.usd ?? "0")}</span> in practice dollars. Nothing here is real money.
            </>
          ) : funding.state === "failed" ? (
            <>{funding.why} You can try again from the next screen.</>
          ) : (
            <>Your account is ready.</>
          )}
        </p>
        <div class="screen__spacer" />
        <Button onClick={onDone} disabled={funding.state === "adding"}>
          Make my first link
        </Button>
        {ws.backup.needed ? (
          <Button
            variant="quiet"
            onClick={() => {
              onDone();
              go("backup");
            }}
          >
            Back it up with my email
          </Button>
        ) : null}
        {ws.backup.needed ? <p class="fine fine--center">Until you back it up, this account lives only in this browser.</p> : null}
      </main>
    </>
  );
}
