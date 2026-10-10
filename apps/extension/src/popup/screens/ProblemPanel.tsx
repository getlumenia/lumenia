/**
 * A refusal, as a calm panel with one thing to do about it. It sits where the form was, so the
 * header stays and the person never loses their place; the form is still there behind it.
 */
import { useState } from "preact/hooks";
import { useAlive } from "../hooks";
import type { Problem } from "../problems";
import { Button, Heading, Mascot } from "../ui";

export function ProblemPanel({ problem, onAction }: { problem: Problem; onAction: () => Promise<void> | void }) {
  const alive = useAlive();
  const [busy, setBusy] = useState(false);
  // Only the unconfirmed-send panel is the main road; every other one is a side road back to the form.
  const stop = problem.code === "uncertain";

  async function act() {
    setBusy(true);
    try {
      await onAction();
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <main class="screen screen--center">
      <section class={stop ? "panel panel--stop" : "panel"}>
        <Mascot pose={stop ? "phone" : "wave"} size="md" />
        <Heading class="h1--panel">{problem.title}</Heading>
        <p class="panel__body">{problem.body}</p>
        <Button variant={stop ? "primary" : "secondary"} onClick={act} busy={busy} busyLabel={problem.action === "open-real" ? "Opening" : problem.label}>
          {problem.label}
        </Button>
      </section>
    </main>
  );
}
