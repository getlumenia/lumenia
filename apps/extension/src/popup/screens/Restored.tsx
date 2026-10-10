/**
 * The beat after a restore (or after "Use another account" brought one in): the account is named
 * once, the way every Lumenia surface names it (LUMENIA ACCOUNT CONTRACT v1, 5.5), so a person with
 * more than one account knows which one this browser now holds.
 */
import type { Restored } from "../context";
import { useApp } from "../context";
import { accountLine, restoredLine } from "../format";
import { BrandBar, Button, Heading, Mascot } from "../ui";

export function RestoredBeat({ restored, onDone }: { restored: Restored; onDone: () => void }) {
  const { go } = useApp();
  // A backup the server says is not tied to this account yet is said as such, with the way to fix it.
  const untied = restored.bound === false ? accountLine({ pubkey: restored.pubkey, email: restored.email, bound: false }, false) : null;
  return (
    <>
      <BrandBar />
      <main class="screen screen--beat" aria-live="polite">
        <Mascot pose="thumbsup" size="lg" label />
        <Heading class="h1--center">Your account is here</Heading>
        <p class="lede lede--center">{restoredLine(restored)}</p>
        {untied ? <p class="fine fine--center">{untied.text}.</p> : null}
        <div class="screen__spacer" />
        <Button onClick={onDone}>Done</Button>
        {untied?.action ? (
          <Button
            variant="quiet"
            onClick={() => {
              onDone();
              go("change-email");
            }}
          >
            {untied.action.label}
          </Button>
        ) : null}
      </main>
    </>
  );
}
