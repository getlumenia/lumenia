/**
 * A fake `chrome` for the self-tests: the parts of the extension API the worker modules touch (storage,
 * alarms, the badge, runtime.id / getURL, and inert tabs / scripting / menus for the router), with
 * storage in memory. src/lib/browser.ts reads
 * globalThis.browser ?? globalThis.chrome when it is IMPORTED, so call installChrome() before the
 * first dynamic import of anything under src/. Tests that use useAreas() (src/lib/storage.ts) pass
 * MemoryArea directly; the chrome.storage adapter is the same data through the real call shapes.
 */
import type { Area } from "../src/lib/storage";

/** An Area that keeps JSON text, so values are copied in and out like chrome.storage does (Infinity -> null, undefined dropped). */
export class MemoryArea implements Area {
  readonly data = new Map<string, string>();
  async get<T = unknown>(key: string): Promise<T | undefined> {
    const raw = this.data.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async getAll(): Promise<Record<string, unknown>> {
    return Object.fromEntries([...this.data].map(([k, v]) => [k, JSON.parse(v) as unknown]));
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [k, v] of Object.entries(items)) if (v !== undefined) this.data.set(k, JSON.stringify(v));
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.data.delete(k);
  }
  async clear(): Promise<void> {
    this.data.clear();
  }
}

export interface AlarmCall {
  op: "create" | "clear" | "clearAll";
  name?: string;
  info?: unknown;
}
export interface FakeChrome {
  local: MemoryArea;
  session: MemoryArea;
  /** every alarms.* call, in order */
  alarms: AlarmCall[];
}

const asChromeArea = (a: MemoryArea) => ({
  async get(keys?: string | string[] | null) {
    const all = await a.getAll();
    if (keys === undefined || keys === null) return all;
    return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in all).map((k) => [k, all[k]]));
  },
  set: (items: Record<string, unknown>) => a.set(items),
  remove: (keys: string | string[]) => a.remove(keys),
  clear: () => a.clear(),
});

export function installChrome(): FakeChrome {
  const local = new MemoryArea();
  const session = new MemoryArea();
  const alarms: AlarmCall[] = [];
  const chrome = {
    storage: { local: asChromeArea(local), session: asChromeArea(session) },
    alarms: {
      create: async (name: string, info: unknown) => void alarms.push({ op: "create", name, info }),
      clear: async (name: string) => (alarms.push({ op: "clear", name }), true),
      clearAll: async () => (alarms.push({ op: "clearAll" }), true),
    },
    action: {
      setBadgeText: async (_details: unknown) => undefined,
      setBadgeBackgroundColor: async (_details: unknown) => undefined,
      openPopup: async () => undefined,
    },
    runtime: {
      id: "test-ext",
      getURL: (p: string) => `chrome-extension://test-ext/${p}`,
      getPlatformInfo: async () => ({ os: "test" }),
    },
    // The paste path, for the router: no tab is active and nothing is injected.
    tabs: { query: async (_q: unknown) => [] },
    scripting: { executeScript: async (_d: unknown) => [] },
    contextMenus: { removeAll: (cb?: () => void) => cb?.(), create: (_p: unknown, cb?: () => void) => cb?.() },
  };
  Object.assign(globalThis, { chrome });
  Reflect.deleteProperty(globalThis, "browser");
  return { local, session, alarms };
}
