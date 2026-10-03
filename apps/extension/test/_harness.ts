/**
 * Shared plumbing for the extension's offline self-tests (tsx, plain Node, no network, no keys).
 *
 * Three things live here so every suite reports and is configured the same way:
 *
 *   - the reporter: ok() / section() / run(), in the house style of apps/web/lib/*.selftest.ts
 *     ("  ok   name", "  FAIL name  (detail)", and a last line "PASS SUITE n/n" or
 *     "FAIL SUITE passed/total" with exit code 1);
 *   - BUILD_ENV: the process.env values build.mjs bakes into the bundle with esbuild `define`. The
 *     web modules read them at import time, so a suite that wants the shipped network
 *     configuration (and, above all, a configured mainnet) installs them BEFORE its first dynamic
 *     import of anything under src/. url.selftest.ts holds this copy to build.mjs;
 *   - sdk(): the Stellar SDK instance the web modules use. apps/web has no "type" in its
 *     package.json, so tsx loads apps/web/lib as CommonJS and it requires the SDK's CJS build,
 *     while a test file in this ESM package that imports the SDK by name gets the ESM build: two
 *     copies, two `rpc.Server.prototype` objects. A fake installed on the ESM copy never reaches
 *     createV2Link. Anything a test patches or hands to the web modules comes from sdk().
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

let passed = 0;
let failed = 0;

export function ok(name: string, cond: boolean, detail = ""): boolean {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? `  (${detail})` : ""}`);
  if (cond) passed++;
  else failed++;
  return cond;
}

export function section(id: string, title: string): void {
  console.log(`\n[${id}] ${title}`);
}

/** The settled answer of a promise, so a rejection can be asserted on without a try/catch per site. */
export async function outcome<T>(p: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
}

export function threw(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

/** Compact JSON for a failure detail, cut so one bad assertion cannot flood the log. */
export function show(v: unknown, max = 240): string {
  let s: string;
  try {
    s = JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x)) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/** Deep equality by JSON text (key order matters, which is what a stored record is held to). */
export const same = (a: unknown, b: unknown): boolean => show(a, 1e9) === show(b, 1e9);

export const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
export const sha256hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** A 64-character lowercase hex id: what a link id (a 32-byte public key) looks like. */
export const hexId = (n: number): string => n.toString(16).padStart(64, "0");

/** Let queued microtasks and timers run (a never-awaited promise advances only when somebody waits). */
export const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** Wait (by yielding, never by sleeping) until `cond` holds, or fail the suite's step loudly. */
export async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (cond()) return;
    await tick();
  }
  throw new Error(`gave up waiting for: ${what}`);
}

/* ------------------------------------ build environment ------------------------------------ */

/** Every string value build.mjs `define`s for process.env.NEXT_PUBLIC_*; url.selftest.ts keeps it equal. */
export const BUILD_ENV: Record<string, string> = {
  NEXT_PUBLIC_SPONSOR_URL: "https://lumenia-sponsor.avakit.workers.dev",
  NEXT_PUBLIC_SPONSOR_URL_MAINNET: "https://lumenia-sponsor-mainnet.avakit.workers.dev",
  NEXT_PUBLIC_LUMENDROP_CONTRACT: "CAMCI5VPRLQUL6H4QKLZ6X7ASLVCEYBYWS7N3QG7JVOA25HCY2TN3HP3",
  NEXT_PUBLIC_LUMENDROP_CONTRACT_MAINNET: "CAC5JYQ2XEEVJ54EXC7KCG6MTARO5CSUQ2WNKSOM6FALCCU5UTEIWGR4",
  NEXT_PUBLIC_LUMENDROP_LEGACY:
    "CDVZN53VEPNE4IFGOUBHOFDYF4N5XJXI5L7LWSN72HPB6ITJCHY4ST6S,CDYEDHBPMDOOZSJGB2Z6JVK7GS3S5CWNXNGTEPMJFS25TAWSYHTXA2RF,CAKEJAGCATVMJB6CMB6LM736DHUJ37YOTOER23SWRNDHPLTU2ZJUDIAB",
  NEXT_PUBLIC_LUMENDROP_LEGACY_MAINNET: "",
  NEXT_PUBLIC_HORIZON: "https://horizon-testnet.stellar.org",
  NEXT_PUBLIC_SOROBAN_RPC: "https://soroban-testnet.stellar.org",
  NEXT_PUBLIC_HORIZON_MAINNET: "https://horizon.stellar.org",
  NEXT_PUBLIC_SOROBAN_RPC_MAINNET: "https://mainnet.sorobanrpc.com",
  NEXT_PUBLIC_FEDERATION_DOMAIN: "getlumenia.com",
};

/**
 * Make process.env what the bundle was compiled with: the values above, and every other
 * NEXT_PUBLIC_* variable (including the two build.mjs defines as undefined) removed, so a
 * developer's shell cannot change what a suite asserts. Call before the first import of src/.
 */
export function installBuildEnv(): void {
  for (const k of Object.keys(process.env)) if (k.startsWith("NEXT_PUBLIC_")) delete process.env[k];
  for (const [k, v] of Object.entries(BUILD_ENV)) process.env[k] = v;
}

export type Sdk = typeof import("@stellar/stellar-sdk");
const req = createRequire(import.meta.url);

/** The Stellar SDK the web modules load (see the header). */
export function sdk(): Sdk {
  return req("@stellar/stellar-sdk") as Sdk;
}

/** A JSON Response, for the fake fetch of a suite. */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/* ------------------------------------------ runner ------------------------------------------ */

/** The last line of a suite: "PASS SUITE n/n", or "FAIL SUITE passed/total" and exit code 1. A suite that asserted nothing fails. */
export function summary(suite: string, crash?: unknown): void {
  const total = passed + failed;
  const good = crash === undefined && failed === 0 && total > 0;
  const why = crash === undefined ? "" : ` (crashed: ${crash instanceof Error ? crash.message : String(crash)})`;
  console.log(`\n${good ? "PASS" : "FAIL"} ${suite} ${good ? total : passed}/${total}${why}`);
  if (!good) process.exit(1);
}

/** Print the header, run the suite, print the verdict. A crash is a failure, never a silent pass. */
export function run(suite: string, title: string, main: () => Promise<void>): void {
  console.log("============================================================");
  console.log(` SELF-TEST - ${title}`);
  console.log("============================================================");
  main().then(
    () => summary(suite),
    (e: unknown) => {
      console.error(e);
      summary(suite, e ?? new Error("rejected with undefined"));
    },
  );
}
