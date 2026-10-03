/**
 * Keep the background alive while one piece of work is pending.
 *
 * Chrome ends an idle extension service worker after about 30 seconds, and a /v2-deposit answer
 * can take up to a minute (the sponsor waits for the ledger before it replies). A call to any
 * extension API resets the idle timer, so a cheap one is made every 20 seconds while the work runs.
 * The persist-before-POST rule is what keeps money safe if the worker dies anyway; this only keeps
 * the answer from being lost in the common case.
 */
import { ext } from "../lib/browser";

const PING_MS = 20_000;
/**
 * Never keep the worker up for more than this, whatever the work is doing (Chrome's guidance is to
 * avoid keeping a service worker alive indefinitely). A send is bounded well inside it: the sponsor
 * answers within about a minute, and the settle loop finishes anything that outlives the worker.
 */
const MAX_KEEPALIVE_MS = 3 * 60_000;

/*
 * Measured on Chrome 153 (Chrome for Testing, 2026-10-03): a bare 60 s fetch in an extension
 * service worker is cut at 30 s; with a runtime.getPlatformInfo() call every 20 s it completes.
 */
export async function keepAlive<T>(work: Promise<T>): Promise<T> {
  const started = Date.now();
  const ping = setInterval(() => {
    if (Date.now() - started > MAX_KEEPALIVE_MS) {
      clearInterval(ping);
      return;
    }
    try {
      void ext.runtime.getPlatformInfo();
    } catch {
      /* nothing to keep alive in a test */
    }
  }, PING_MS);
  try {
    return await work;
  } finally {
    clearInterval(ping);
  }
}
