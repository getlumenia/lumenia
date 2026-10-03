/**
 * No account in this browser yet. The extension holds an account that was made on getlumenia.com and
 * restored here from its backup; it does not make accounts of its own.
 */
import { URLS } from "../../config";
import { useApp } from "../context";
import { BrandBar, Button, ExtLink, Heading, openUrl } from "../ui";

export function Connect() {
  const { startRestore } = useApp();
  return (
    <>
      <BrandBar />
      <main class="screen">
        <Heading>Send dollars by link</Heading>
        <p class="lede">The person you send to needs no wallet and no app, and pays no gas.</p>
        <ul class="facts facts--tight">
          <li>
            <strong>Your key</strong>{" "}
            <span>stays in this browser, locked with your password.</span>
          </li>
          <li>
            <strong>Your links</strong>{" "}
            <span>are listed in this browser only.</span>
          </li>
          <li>
            <strong>The money</strong>{" "}
            <span>waits in escrow until it's claimed. If nobody claims it, you can take it back after 7 days.</span>
          </li>
        </ul>
        <div class="screen__spacer" />
        <Button onClick={startRestore}>Restore my Lumenia account</Button>
        <Button variant="secondary" onClick={() => openUrl(URLS.start)}>
          I don't have an account
        </Button>
        <p class="fine fine--center">
          Needs a password backup. Make one on <ExtLink href={URLS.backup}>your account page on getlumenia.com</ExtLink>.
        </p>
        <p class="fine fine--center">Passkey (Face ID) backups open on getlumenia.com only.</p>
      </main>
    </>
  );
}
