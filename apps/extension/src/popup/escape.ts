/**
 * Escape goes back one screen. The shell owns the default (back, or close on the home screen); a
 * screen with something of its own to dismiss (a confirm step, an error panel) registers a handler
 * here that answers true when it used the key. The newest handler is asked first.
 */
import { useLayoutEffect, useRef } from "preact/hooks";

type Handler = () => boolean;
const stack: Handler[] = [];

function push(h: Handler): () => void {
  stack.push(h);
  return () => {
    const i = stack.lastIndexOf(h);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Ask the registered handlers, newest first. True when one of them used the key. */
export function runEscape(): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!()) return true;
  }
  return false;
}

/**
 * Register for the life of the component; `handler` may change on every render. A layout effect, so
 * the handler is live the moment the screen is, not a frame later.
 */
export function useEscape(handler: Handler): void {
  const latest = useRef(handler);
  latest.current = handler;
  useLayoutEffect(() => push(() => latest.current()), []);
}
