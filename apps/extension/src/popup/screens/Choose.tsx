/**
 * No account in this browser yet: one question, two answers. A new account is made right here; an
 * existing one (made on getlumenia.com or in another browser) is brought over from its backup.
 */
import { useApp } from "../context";
import { Bubble, Button, BrandBar, Mascot } from "../ui";

export function Choose() {
  const { startCreate, startRestore } = useApp();
  return (
    <>
      <BrandBar />
      <main class="screen screen--beat">
        <div class="beat">
          <Bubble class="beat__bubble">Do you already have a Lumenia account?</Bubble>
          <Mascot pose="wave" size="lg" />
        </div>
        <h1 class="sr-only">Do you already have a Lumenia account?</h1>
        <div class="screen__spacer" />
        <Button onClick={startCreate}>No, I'm new here</Button>
        <Button variant="secondary" onClick={startRestore}>
          Yes, bring it here
        </Button>
      </main>
    </>
  );
}
