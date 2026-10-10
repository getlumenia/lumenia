/**
 * No account in this browser yet: one question, two answers. A new account is made right here; an
 * existing one (made on getlumenia.com or in another browser) is brought over from its backup. The
 * first answer says what it makes: a NEW account, not the one the person may already have on the
 * website (a second key, with its own backup email and its own real-money standing).
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
        <p class="fine fine--center">This makes a new account, separate from any account you have on getlumenia.com.</p>
        <Button variant="secondary" onClick={startRestore}>
          Yes, bring it here
        </Button>
      </main>
    </>
  );
}
