/**
 * fake-kv: a local stand-in for the Upstash Redis REST API, for `wrangler dev` runs that must never
 * touch the production store (the adversarial run's halt and pre-seeded-counter sections, SOW 2 D3
 * item j, and any rehearsal of the kill switch).
 *
 * Speaks exactly the subset this service uses (lib/rate-limit.ts, caps.ts, pilot.ts, kill-switch.ts,
 * watchdog.ts, channels.ts, events.ts, waitlist.ts, feedback.ts, recovery-*.ts, handles.ts,
 * identity-links.ts): `POST /pipeline` with a two-dimensional command array, and the single-command
 * paths `/get/<key>`, `/set/<key>/<value>`, `/del/<key>`, `/sadd/<set>/<member>`, `/incr/<key>`,
 * `/rpush/<list>/<value>`, `/ltrim/<list>/<start>/<stop>`. Replies are shaped like Upstash's
 * (`{result}` or `[{result}, ...]`, `null` for a missing key, `"OK"` for SET, integers for the
 * counters, `["0", [...]]` for SCAN). Anything else answers `{error: "UNSUPPORTED <cmd>"}` and is
 * printed, so a new command in the service shows up here rather than as a silent wrong answer.
 *
 * EVAL runs no Lua: it interprets the one family of scripts the service sends, a fenced update
 * `if redis.call('get', KEYS[1]) == ARGV[1] then <calls> else return 0 end` (the channel pool's
 * release in lib/channels.ts, and the onboarding slot's fenced release in lib/caps.ts, which also
 * gives back one slot on KEYS[2] and KEYS[3]). Any other script shape is UNSUPPORTED.
 *
 * Three operator endpoints, not part of Upstash: `GET /__dump` (the whole map, for a test to read
 * counters), `GET /__gross/<key>` (every positive increment the key ever took, never reduced: the
 * adversarial run's proof that no fee was charged, which a counter that also gives back cannot
 * show) and `POST /__reset` (empty it). No auth check: it binds to 127.0.0.1 only.
 *
 * RUN: pnpm --filter @lumenia/sponsor fake-kv --port 8765
 *      npx wrangler dev --var KV_REST_API_URL:http://127.0.0.1:8765 --var KV_REST_API_TOKEN:local
 * CHECK (offline, no port): pnpm --filter @lumenia/sponsor fake-kv --selftest
 */
import { readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";

type Value = { kind: "string"; value: string } | { kind: "set"; value: Set<string> } | { kind: "list"; value: string[] };

const store = new Map<string, Value>();
const expiry = new Map<string, number>();
/**
 * Per key, the sum of every positive increment it has taken, never reduced. The sponsor's fee
 * budget charges a bid with INCRBY before it signs and may give the bid back with a negative
 * INCRBY once the network refused the transaction while validating it, so the net value cannot tell
 * "charged, signed, given back" from "never charged". The adversarial run reads this instead.
 */
const gross = new Map<string, bigint>();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}
const PORT = Number.parseInt(arg("port", "8765"), 10);
const QUIET = process.argv.includes("--quiet");

function live(key: string): Value | undefined {
  const until = expiry.get(key);
  if (until !== undefined && Date.now() >= until) {
    store.delete(key);
    expiry.delete(key);
    return undefined;
  }
  return store.get(key);
}

function getString(key: string): string | null {
  const v = live(key);
  return v && v.kind === "string" ? v.value : null;
}

function setString(key: string, value: string): void {
  store.set(key, { kind: "string", value });
}

function getSet(key: string): Set<string> {
  const v = live(key);
  if (v && v.kind === "set") return v.value;
  const s = new Set<string>();
  store.set(key, { kind: "set", value: s });
  return s;
}

function getList(key: string): string[] {
  const v = live(key);
  if (v && v.kind === "list") return v.value;
  const l: string[] = [];
  store.set(key, { kind: "list", value: l });
  return l;
}

function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

type Reply = { result: unknown } | { error: string };

/**
 * The script family the service sends to EVAL, interpreted, not run: a fenced update that acts only
 * while KEYS[1] still holds the caller's token (ARGV[1]). The channel pool's release returns its
 * DEL's count; the onboarding slot's release deletes its marker, gives one back on KEYS[2] and
 * KEYS[3], and returns 1. Every statement is parsed before any runs, so a script with one statement
 * this does not know changes nothing and answers UNSUPPORTED, instead of half running.
 */
const FENCED = /^if\s+redis\.call\(\s*['"](?:get|GET)['"]\s*,\s*KEYS\[1\]\s*\)\s*==\s*ARGV\[1\]\s+then\s+([\s\S]+?)\s+else\s+return\s+0\s+end$/;
const CALL = /^redis\.call\(\s*['"]([A-Za-z]+)['"]\s*((?:,\s*(?:KEYS\[\d+\]|ARGV\[\d+\]|-?\d+)\s*)*)\)$/;
/** The commands a fenced release may make; anything else in a script is UNSUPPORTED. */
const SCRIPT_COMMANDS = new Set(["DEL", "INCRBY", "DECRBY", "INCR", "DECR", "EXPIRE", "PEXPIRE"]);

function evalFenced(script: string, keys: string[], argv: string[]): Reply {
  const unsupported: Reply = { error: `UNSUPPORTED EVAL ${script.slice(0, 60)}` };
  const m = FENCED.exec(script.trim());
  if (!m) return unsupported;
  type Step = { run: string[]; returns: boolean } | { value: number };
  const steps: Step[] = [];
  // Lua separates statements with ";" or a line break; either is accepted.
  const statements = m[1]!
    .split(/;|\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const [i, raw] of statements.entries()) {
    const isReturn = raw.startsWith("return ");
    const body = isReturn ? raw.slice("return ".length).trim() : raw;
    if (isReturn && i !== statements.length - 1) return unsupported; // nothing may follow a return
    if (isReturn && /^-?\d+$/.test(body)) {
      steps.push({ value: Number(body) });
      continue;
    }
    const c = CALL.exec(body);
    if (!c || !SCRIPT_COMMANDS.has(c[1]!.toUpperCase())) return unsupported;
    const operands: string[] = [];
    for (const a of c[2]!.split(",").map((s) => s.trim()).filter(Boolean)) {
      const ref = /^(KEYS|ARGV)\[(\d+)\]$/.exec(a);
      const v = ref ? (ref[1] === "KEYS" ? keys : argv)[Number(ref[2]) - 1] : a;
      if (v === undefined) return { error: `ERR ${a} is not set (${keys.length} keys, ${argv.length} args)` };
      operands.push(v);
    }
    steps.push({ run: [c[1]!.toUpperCase(), ...operands], returns: isReturn });
  }
  if (keys[0] === undefined || argv[0] === undefined) return { error: "ERR the fence needs KEYS[1] and ARGV[1]" };
  if (getString(keys[0]) !== argv[0]) return { result: 0 };
  let result: unknown = null; // a script that falls off its end returns nil
  for (const s of steps) {
    if ("value" in s) {
      result = s.value;
      break;
    }
    const r = run(s.run);
    if ("error" in r) return r;
    if (s.returns) {
      result = r.result;
      break;
    }
  }
  return { result };
}

/** One Redis command, Upstash-shaped reply; a command that throws answers an error, not a crash. */
function run(cmd: string[]): Reply {
  try {
    return runOne(cmd);
  } catch (e) {
    return { error: `ERR ${(e as Error).message}` };
  }
}

function runOne(cmd: string[]): Reply {
  const [op0, ...args] = cmd;
  const op = String(op0 ?? "").toUpperCase();
  const key = String(args[0] ?? "");
  switch (op) {
    case "GET":
      return { result: getString(key) };
    case "SET": {
      // SET key value [NX | XX] [GET] [EX s | PX ms | KEEPTTL], as Redis reads it. XX writes only
      // over a key that exists (a fenced update of a slot this caller still holds); KEEPTTL keeps
      // the expiry such an update must not reset. An unknown flag is an error, not a guess.
      const value = String(args[1] ?? "");
      let nx = false;
      let xx = false;
      let get = false;
      let keepTtl = false;
      let ttlMs: number | null = null;
      for (let i = 2; i < args.length; i++) {
        const flag = String(args[i]).toUpperCase();
        if (flag === "NX") nx = true;
        else if (flag === "XX") xx = true;
        else if (flag === "GET") get = true;
        else if (flag === "KEEPTTL") keepTtl = true;
        else if (flag === "EX" || flag === "PX") {
          const n = Number(args[++i]);
          if (!Number.isInteger(n) || n <= 0) return { error: "ERR invalid expire time in 'set' command" };
          ttlMs = flag === "EX" ? n * 1000 : n;
        } else return { error: `UNSUPPORTED SET flag ${flag}` };
      }
      if ((nx && xx) || (keepTtl && ttlMs !== null)) return { error: "ERR syntax error" };
      const previous = getString(key);
      const exists = live(key) !== undefined;
      if ((nx && exists) || (xx && !exists)) return { result: get ? previous : null };
      setString(key, value);
      if (ttlMs !== null) expiry.set(key, Date.now() + ttlMs);
      else if (!keepTtl) expiry.delete(key);
      return { result: get ? previous : "OK" };
    }
    case "DEL": {
      let n = 0;
      for (const k of args) {
        if (live(String(k)) !== undefined) n++;
        store.delete(String(k));
        expiry.delete(String(k));
      }
      return { result: n };
    }
    case "EXISTS":
      return { result: args.filter((k) => live(String(k)) !== undefined).length };
    case "INCR":
    case "DECR":
    case "INCRBY":
    case "DECRBY": {
      const delta = op === "INCR" ? 1n : op === "DECR" ? -1n : op === "INCRBY" ? BigInt(String(args[1])) : -BigInt(String(args[1]));
      if (delta > 0n) gross.set(key, (gross.get(key) ?? 0n) + delta);
      const current = getString(key);
      const next = (current === null ? 0n : BigInt(current)) + delta;
      setString(key, next.toString());
      return { result: Number(next) };
    }
    case "EXPIRE":
      if (live(key) === undefined) return { result: 0 };
      expiry.set(key, Date.now() + Number(args[1]) * 1000);
      return { result: 1 };
    case "PEXPIRE":
      if (live(key) === undefined) return { result: 0 };
      expiry.set(key, Date.now() + Number(args[1]));
      return { result: 1 };
    case "TTL": {
      const until = expiry.get(key);
      if (live(key) === undefined) return { result: -2 };
      return { result: until === undefined ? -1 : Math.max(0, Math.round((until - Date.now()) / 1000)) };
    }
    case "SCAN": {
      const at = args.map((a) => String(a).toUpperCase()).indexOf("MATCH");
      const re = at >= 0 ? globToRegExp(String(args[at + 1])) : /.*/;
      const keys = [...store.keys()].filter((k) => live(k) !== undefined && re.test(k));
      return { result: ["0", keys] };
    }
    case "SADD": {
      const s = getSet(key);
      let added = 0;
      for (const m of args.slice(1)) if (!s.has(String(m))) (s.add(String(m)), added++);
      return { result: added };
    }
    case "SREM": {
      const s = getSet(key);
      let removed = 0;
      for (const m of args.slice(1)) if (s.delete(String(m))) removed++;
      return { result: removed };
    }
    case "SMEMBERS":
      return { result: [...getSet(key)] };
    case "SCARD":
      return { result: getSet(key).size };
    case "SISMEMBER":
      return { result: getSet(key).has(String(args[1])) ? 1 : 0 };
    case "SINTER": {
      const sets = args.map((k) => getSet(String(k)));
      const [first, ...rest] = sets;
      return { result: first ? [...first].filter((m) => rest.every((s) => s.has(m))) : [] };
    }
    case "LPUSH": {
      const l = getList(key);
      for (const v of args.slice(1)) l.unshift(String(v));
      return { result: l.length };
    }
    case "RPUSH": {
      const l = getList(key);
      for (const v of args.slice(1)) l.push(String(v));
      return { result: l.length };
    }
    case "LTRIM": {
      const l = getList(key);
      const start = Number(args[1]);
      const stop = Number(args[2]);
      const end = stop < 0 ? l.length + stop + 1 : stop + 1;
      const kept = l.slice(start, end);
      store.set(key, { kind: "list", value: kept });
      return { result: "OK" };
    }
    case "LPOP": {
      const l = getList(key);
      return { result: l.length ? l.shift()! : null };
    }
    case "RPOP": {
      const l = getList(key);
      return { result: l.length ? l.pop()! : null };
    }
    case "LLEN":
      return { result: getList(key).length };
    case "LRANGE": {
      const l = getList(key);
      const start = Number(args[1]);
      const stop = Number(args[2]);
      const end = stop < 0 ? l.length + stop + 1 : stop + 1;
      return { result: l.slice(start, end) };
    }
    case "MGET":
      return { result: args.map((k) => getString(String(k))) };
    case "EVAL": {
      // EVAL script numkeys key [key ...] arg [arg ...]
      const numkeys = Number(args[1]);
      if (!Number.isInteger(numkeys) || numkeys < 0 || numkeys > args.length - 2) {
        return { error: "ERR Number of keys can't be greater than number of args" };
      }
      return evalFenced(String(args[0] ?? ""), args.slice(2, 2 + numkeys).map(String), args.slice(2 + numkeys).map(String));
    }
    default:
      return { error: `UNSUPPORTED ${op}` };
  }
}

function send(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(json) });
  res.end(json);
}

const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  const segs = path.split("/").slice(1).map((s) => decodeURIComponent(s));

  let reply: unknown;
  if (path === "/pipeline") {
    let cmds: string[][];
    try {
      cmds = JSON.parse(body) as string[][];
    } catch {
      return send(res, 400, { error: "pipeline body must be a JSON array" });
    }
    reply = cmds.map((c) => run(c.map(String)));
    for (const r of reply as Reply[]) if ("error" in r) console.error(`[fake-kv] ${r.error}`);
  } else if (path === "/__dump") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of store) if (live(k) !== undefined) out[k] = v.kind === "string" ? v.value : v.kind === "set" ? [...v.value] : v.value;
    reply = out;
  } else if (path === "/__reset") {
    store.clear();
    expiry.clear();
    gross.clear();
    reply = { result: "OK" };
  } else if (segs[0] === "__gross" && segs.length === 2) {
    // A decimal string, like the counters Upstash returns for GET.
    reply = { result: (gross.get(segs[1]!) ?? 0n).toString() };
  } else if (segs.length >= 2) {
    // Single-command paths: /<cmd>/<key>[/<arg>...]. The flags Upstash accepts as a query string
    // (`?EX=60`) are folded in the same way.
    const [cmd, ...rest] = segs;
    const extra: string[] = [];
    for (const [k, v] of url.searchParams) extra.push(k, v);
    const r = run([cmd!, ...rest, ...extra]);
    if ("error" in r) console.error(`[fake-kv] ${r.error}`);
    reply = r;
  } else {
    return send(res, 404, { error: "not found" });
  }
  if (!QUIET) console.log(`[fake-kv] ${req.method} ${path}${path === "/pipeline" ? ` ${body.slice(0, 160)}` : ""}`);
  send(res, 200, reply);
});

/* ------------------------------------- self-test ------------------------------------- */

/** The onboarding slot's fenced release (lib/caps.ts), exactly as the service sends it. */
const ONBOARDING_RELEASE =
  "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('del', KEYS[1]); redis.call('incrby', KEYS[2], -1); redis.call('incrby', KEYS[3], -1); return 1 else return 0 end";

/**
 * Offline: no port of anyone else's is touched (the one HTTP round trip binds an ephemeral port on
 * 127.0.0.1 and closes it). Every script literal the service holds in lib/*.ts is also put through
 * the interpreter, so a new or reworded script fails here instead of answering wrong in a run.
 */
async function selftest(): Promise<number> {
  let passed = 0;
  let failed = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    if (ok) passed++;
    else failed++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
  };
  const fresh = () => {
    store.clear();
    expiry.clear();
    gross.clear();
  };
  const r = (cmd: Array<string | number>) => run(cmd.map(String));
  const res = (reply: Reply) => ("error" in reply ? `error: ${reply.error}` : reply.result);

  console.log("SET flags");
  fresh();
  check("SET XX on a missing key writes nothing and answers nil", res(r(["SET", "k", "v", "XX"])) === null && getString("k") === null);
  check("SET XX on a present key overwrites it", res(r(["SET", "k", "v1"])) === "OK" && res(r(["SET", "k", "v2", "XX"])) === "OK" && getString("k") === "v2");
  check("SET NX on a present key writes nothing", res(r(["SET", "k", "v3", "NX"])) === null && getString("k") === "v2");
  r(["SET", "t", "a", "EX", 60]);
  check("SET XX KEEPTTL keeps the expiry", res(r(["SET", "t", "b", "XX", "KEEPTTL"])) === "OK" && Number(res(r(["TTL", "t"]))) > 0);
  check("SET XX without KEEPTTL clears the expiry", res(r(["SET", "t", "c", "XX"])) === "OK" && res(r(["TTL", "t"])) === -1);
  check("SET NX EX sets an expiry", res(r(["SET", "n", "x", "NX", "EX", 30])) === "OK" && Number(res(r(["TTL", "n"]))) > 0);
  // The onboarding slot re-stamps its marker with this shape (lib/caps.ts): only while it still exists.
  check("SET XX EX on a present key overwrites it and sets a fresh expiry", res(r(["SET", "n", "y", "XX", "EX", 172800])) === "OK" && getString("n") === "y" && Number(res(r(["TTL", "n"]))) > 30);
  check("SET XX EX on a missing key writes nothing", res(r(["SET", "gone", "y", "XX", "EX", 60])) === null && getString("gone") === null);
  check("SET XX GET answers the old value", res(r(["SET", "k", "v4", "XX", "GET"])) === "v2" && getString("k") === "v4");
  check("SET with NX and XX together is a syntax error", "error" in r(["SET", "k", "v", "NX", "XX"]));
  check("SET with an unknown flag is an error, not a guess", "error" in r(["SET", "k", "v", "PXAT", 1]));

  console.log("the gross of a counter that also gives back");
  fresh();
  r(["INCRBY", "fees", "300"]);
  r(["INCRBY", "fees", "-300"]);
  check("a charge given back leaves the net where it was", getString("fees") === "0");
  check("...and the gross still holds the charge", gross.get("fees") === 300n);
  r(["SET", "fees", "5"]);
  r(["DECR", "fees"]);
  check("SET and decrements do not add to the gross", gross.get("fees") === 300n);

  console.log("EVAL: the onboarding slot's fenced release");
  fresh();
  r(["SET", "marker", "tok"]);
  r(["SET", "day", "5"]);
  r(["SET", "src", "2"]);
  check("a wrong token answers 0 and changes nothing", res(r(["EVAL", ONBOARDING_RELEASE, 3, "marker", "day", "src", "other"])) === 0 && getString("marker") === "tok" && getString("day") === "5" && getString("src") === "2");
  check("the holder's token answers 1", res(r(["EVAL", ONBOARDING_RELEASE, 3, "marker", "day", "src", "tok"])) === 1);
  check("...deletes the marker and gives one back on both counters", getString("marker") === null && getString("day") === "4" && getString("src") === "1");
  check("a second release answers 0 (the marker is gone) and gives back nothing", res(r(["EVAL", ONBOARDING_RELEASE, 3, "marker", "day", "src", "tok"])) === 0 && getString("day") === "4" && getString("src") === "1");
  check("too few keys for the script is an error, not a partial run", "error" in r(["EVAL", ONBOARDING_RELEASE, 1, "marker", "tok"]));

  console.log("EVAL: the same fence spelled the way Redis's own SET page spells its unlock script");
  // Double quotes, no spaces after commas, a statement per line (redis.io/docs/latest/commands/set).
  const DOCS_UNLOCK = 'if redis.call("get",KEYS[1]) == ARGV[1]\nthen\n    return redis.call("del",KEYS[1])\nelse\n    return 0\nend';
  fresh();
  r(["SET", "lock", "tok"]);
  check("a wrong token answers 0", res(r(["EVAL", DOCS_UNLOCK, 1, "lock", "other"])) === 0 && getString("lock") === "tok");
  check("the holder's token answers DEL's count and frees the lock", res(r(["EVAL", DOCS_UNLOCK, 1, "lock", "tok"])) === 1 && getString("lock") === null);

  console.log("EVAL: the script shapes the interpreter must refuse");
  fresh();
  r(["SET", "k", "tok"]);
  check("a script outside the fenced family is UNSUPPORTED", "error" in r(["EVAL", "return redis.call('flushall')", 0]));
  check("a fenced script with a command outside the list is UNSUPPORTED", "error" in r(["EVAL", "if redis.call('get', KEYS[1]) == ARGV[1] then redis.call('flushall'); return 1 else return 0 end", 1, "k", "tok"]));
  check("...and runs none of its statements", getString("k") === "tok");
  check("a statement after the return is UNSUPPORTED", "error" in r(["EVAL", "if redis.call('get', KEYS[1]) == ARGV[1] then return 1; redis.call('del', KEYS[1]) else return 0 end", 1, "k", "tok"]));
  check("INCRBY on a value that is not a number is an error, not a crash", "error" in r(["INCRBY", "k", 1]));

  console.log("EVAL: every script literal in apps/sponsor/src/lib");
  const libDir = new URL("../lib/", import.meta.url);
  let found = 0;
  for (const file of readdirSync(libDir).filter((f) => f.endsWith(".ts"))) {
    const src = readFileSync(new URL(file, libDir), "utf8");
    // A one-line double-quoted literal that starts like a script (the shape both releases use); a
    // comment that merely mentions redis.call is not one.
    for (const m of src.matchAll(/"(\s*(?:if|return|local)\b(?:[^"\\\n]|\\.)*redis\.call\((?:[^"\\\n]|\\.)*)"/g)) {
      const script = m[1]!.replace(/\\(["'\\])/g, "$1");
      found++;
      const nKeys = Math.max(1, ...[...script.matchAll(/KEYS\[(\d+)\]/g)].map((k) => Number(k[1])));
      const keys = Array.from({ length: nKeys }, (_, i) => `k${i + 1}`);
      fresh();
      keys.forEach((k, i) => r(["SET", k, i === 0 ? "tok" : "7"]));
      const closed = r(["EVAL", script, nKeys, ...keys, "other"]);
      check(`${file}: the fence holds for a wrong token`, res(closed) === 0 && getString("k1") === "tok", String(res(closed)));
      const open = r(["EVAL", script, nKeys, ...keys, "tok"]);
      check(`${file}: the holder's token runs it`, !("error" in open) && getString("k1") === null, String(res(open)));
    }
  }
  check("found the service's scripts (at least the channel pool's release)", found >= 1, `${found} found`);

  console.log("the HTTP pipeline shape");
  fresh();
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", () => resolveListen()));
  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const reply = await fetch(`http://127.0.0.1:${port}/pipeline`, {
      method: "POST",
      body: JSON.stringify([
        ["SET", "m", "tok", "NX", "EX", "60"],
        ["INCRBY", "d", "2"],
        ["INCRBY", "s", "2"],
        ["EVAL", ONBOARDING_RELEASE, "3", "m", "d", "s", "tok"],
        ["MGET", "m", "d", "s"],
      ]),
    });
    const rows = (await reply.json()) as Array<{ result?: unknown; error?: string }>;
    check("a pipeline answers one {result} per command, in order", JSON.stringify(rows) === JSON.stringify([{ result: "OK" }, { result: 2 }, { result: 2 }, { result: 1 }, { result: [null, "1", "1"] }]), JSON.stringify(rows));
    const grossReply = (await (await fetch(`http://127.0.0.1:${port}/__gross/d`)).json()) as { result?: unknown };
    check("GET /__gross/<key> answers the gross as a decimal string (2 in, 1 given back: 2)", grossReply.result === "2", JSON.stringify(grossReply));
  } finally {
    server.close();
  }

  console.log(`\nFAKE-KV SELF-TEST ${failed === 0 ? "PASS" : "FAIL"} ${passed}/${passed + failed}`);
  return failed === 0 ? 0 : 1;
}

if (process.argv.includes("--selftest")) {
  selftest().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`fake-kv self-test crashed: ${(e as Error).stack ?? String(e)}`);
      process.exit(1);
    },
  );
} else {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`fake-kv listening on http://127.0.0.1:${PORT} (Upstash REST subset; /__dump, /__reset)`);
  });
}
