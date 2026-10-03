/**
 * First run: the landing page's opening, in the popup. The messenger has a message for you, and
 * there is one thing to do. Nothing has left this browser yet; nothing does before the next screen.
 */
import { Bubble, Button, Mascot, Wordmark } from "../ui";

export function Hello({ onStart }: { onStart: () => void }) {
  return (
    <main class="hello">
      <h1 class="sr-only">Lumenia: send dollars by link</h1>
      <Wordmark class="hello__wordmark" />
      <div class="hello__stage">
        <span class="hello__sparks" aria-hidden="true" />
        <Bubble class="hello__bubble">Hey, I've got a message for you.</Bubble>
        <Mascot pose="messenger" size="xl" label />
      </div>
      <Button onClick={onStart} class="hello__go">
        Get started
      </Button>
    </main>
  );
}
