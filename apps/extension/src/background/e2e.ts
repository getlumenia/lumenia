/**
 * The END-TO-END build's background entry, never a store build's (build.mjs uses it only with
 * --e2e-ttl, and that build is never zipped).
 *
 * A context-menu click cannot be made by an automated browser, so this exposes the click handler to
 * the test, which calls it the way Chrome would after a right-click in an editable field. Everything
 * else is the real worker, loaded unchanged from ./index.
 */
import "./index";
import { insertLink, onMenuClicked } from "./insert";

(globalThis as unknown as { __lumeniaE2E: unknown }).__lumeniaE2E = { onMenuClicked, insertLink };
