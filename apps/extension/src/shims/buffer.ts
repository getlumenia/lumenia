/**
 * Injected by build.mjs into every bundle: apps/web/lib/lumendrop.ts uses the `Buffer` global without
 * importing it (Next.js provides one in the browser; an extension service worker has none). esbuild
 * replaces each free `Buffer` reference with this import, so nothing is assigned to globalThis.
 */
import { Buffer } from "buffer";

export { Buffer };
