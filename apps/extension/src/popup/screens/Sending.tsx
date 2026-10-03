/**
 * A link is being made. The worker keeps going if the popup closes (Chrome closes it on any click
 * outside it), so the screen says so once the wait is long enough to matter.
 */
import { useEffect, useState } from "preact/hooks";
import { formatUsd } from "../../core";
import { useApp } from "../context";
import { Heading, Mascot, Progress } from "../ui";

const SLOW_AFTER_MS = 15_000;

export function Sending({ amount: given, startedAt }: { amount: string | null; startedAt: number }) {
  const { records } = useApp();
  // Reopened mid-send, the form's amount is gone; the record the worker writes before it posts has it.
  const amount = given ?? records.find((r) => r.createdAt >= startedAt - 2000)?.amount ?? null;
  const [slow, setSlow] = useState(() => Date.now() - startedAt > SLOW_AFTER_MS);
  useEffect(() => {
    if (slow) return;
    const t = window.setTimeout(() => setSlow(true), Math.max(0, SLOW_AFTER_MS - (Date.now() - startedAt)));
    return () => window.clearTimeout(t);
  }, [slow, startedAt]);

  return (
    <main class="screen screen--center" aria-live="polite">
      <div class="sending">
        <Mascot pose="messenger" size="lg" class="mascot--flying" />
        <Heading class="h1--center">
          Putting {amount ? <span class="money">{formatUsd(amount)}</span> : "your money"} in the link.
        </Heading>
        <p class="lede lede--center">This usually takes a few seconds.</p>
        <Progress label="Making your link" />
        {slow ? (
          <p class="fine fine--center">
            This one is taking longer than usual. You can close this window; it will finish anyway, and the link will be in Links.
          </p>
        ) : null}
      </div>
    </main>
  );
}
