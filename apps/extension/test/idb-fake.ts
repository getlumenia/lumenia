/**
 * A small in-memory IndexedDB for the self-tests that drive the worker end to end (router.selftest.ts):
 * the web keystore (apps/web/lib/keystore.ts) and the kept links (src/lib/sealed.ts) both live in
 * IndexedDB, and Node has none.
 *
 * It implements only the calls those two modules make (open with an upgrade, one object store per
 * transaction, put / get / getAll / delete / clear, deleteDatabase), with the same event shape: every
 * request answers on a later tick through onsuccess / onerror, and a transaction's oncomplete fires
 * after its request. Values are kept as given (no structured clone); the tests never mutate them.
 */
type Handler = (() => void) | null;

class FakeRequest<T = unknown> {
  result!: T;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

type Store = Map<string, Record<string, unknown>>;

export interface FakeIdb {
  /** database name -> store name -> key -> value */
  dbs: Map<string, Map<string, Store>>;
}

export function installIdb(): FakeIdb {
  const dbs = new Map<string, Map<string, Store>>();
  const later = (fn: () => void) => setTimeout(fn, 0);

  const idb = {
    open(name: string, _version?: number) {
      const req = new FakeRequest<unknown>();
      later(() => {
        const fresh = !dbs.has(name);
        if (fresh) dbs.set(name, new Map());
        const stores = dbs.get(name)!;
        req.result = {
          objectStoreNames: { contains: (s: string) => stores.has(s) },
          createObjectStore: (s: string, _opts?: unknown) => void stores.set(s, new Map()),
          deleteObjectStore: (s: string) => void stores.delete(s),
          close() {},
          transaction(storeName: string, _mode?: string) {
            const tx: Record<string, unknown> & { oncomplete: Handler; onerror: Handler; onabort: Handler; error: unknown } = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              error: null,
            };
            const store = stores.get(storeName);
            const run = <R>(fn: () => R) => {
              const r = new FakeRequest<R>();
              later(() => {
                try {
                  if (!store) throw new Error(`no object store ${storeName}`);
                  r.result = fn();
                } catch (e) {
                  r.error = e;
                  tx.error = e;
                  r.onerror?.();
                  tx.onerror?.();
                  return;
                }
                r.onsuccess?.();
                later(() => tx.oncomplete?.());
              });
              return r;
            };
            const keyOf = (v: Record<string, unknown>) => String(v.id);
            tx.objectStore = () => ({
              put: (v: Record<string, unknown>) => run(() => (store!.set(keyOf(v), v), keyOf(v))),
              get: (k: string) => run(() => store!.get(k)),
              getAll: () => run(() => [...store!.values()]),
              delete: (k: string) => run(() => void store!.delete(k)),
              clear: () => run(() => void store!.clear()),
            });
            return tx;
          },
        };
        if (fresh) req.onupgradeneeded?.();
        req.onsuccess?.();
      });
      return req;
    },
    deleteDatabase(name: string) {
      const req = new FakeRequest<undefined>();
      later(() => {
        dbs.delete(name);
        req.onsuccess?.();
      });
      return req;
    },
  };
  Object.assign(globalThis, { indexedDB: idb });
  return { dbs };
}
