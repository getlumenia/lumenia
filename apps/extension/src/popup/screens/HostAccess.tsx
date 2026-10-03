/**
 * Firefox lets a person withhold an extension's access to websites, and the extension talks to
 * exactly six hosts. The request is made INSIDE the click handler (a permission prompt needs a user
 * gesture), then the worker's state is read again.
 */
import { useState } from "preact/hooks";
import { API_HOSTS } from "../../config";
import { ext } from "../../lib/browser";
import { useApp } from "../context";
import { BrandBar, Button, Heading, Notice, Mascot } from "../ui";

export function HostAccess() {
  const { refresh } = useApp();
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);

  async function allow() {
    setBusy(true);
    setDenied(false);
    let granted = false;
    try {
      granted = Boolean(await ext.permissions.request({ origins: [...API_HOSTS] }));
    } catch {
      granted = false;
    }
    const next = await refresh();
    setBusy(false);
    // Whether the browser said yes or no, the worker's own reading is what counts.
    if (!granted || (next && !next.hostAccess)) setDenied(true);
  }

  return (
    <>
      <BrandBar />
      <main class="screen">
        <Mascot pose="phone" size="md" />
        <Heading>Allow Lumenia to reach its servers</Heading>
        <p class="lede">
          Your browser asks before an extension can contact a website. Lumenia only contacts its own servers and the public
          network's data services, and nothing else.
        </p>
        <p class="lede">Without this, Lumenia can't make a link or check whether one was claimed.</p>
        <div class="screen__spacer" />
        {denied ? (
          <Notice tone="error">
            The permission wasn't given. You can try again, or allow it later from this extension's permissions in your browser.
          </Notice>
        ) : null}
        <Button onClick={allow} busy={busy} busyLabel="Waiting for your browser">
          Allow access
        </Button>
      </main>
    </>
  );
}
