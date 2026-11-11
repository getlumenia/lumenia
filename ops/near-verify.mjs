#!/usr/bin/env node
// Checks the NEAR rail of this monorepo the way a judge or a coding agent would:
//   pnpm near:verify            offline gate (escrow crate tests, the near package, the NEAR suites of web /
//                               sponsor / agent-market, the agent MCP self-test) + live read-only checks
//   pnpm near:verify:offline    the same without any network call of its own
//   pnpm near:verify:live       only the live read-only checks (no tests, about 2 seconds)
// Flags: --offline (no live checks), --live-only (no offline steps), --only <step> runs just that step (one of
// contract, near, web, sponsor, agent-market, agentmcp, live), --skip-install (accepted for compatibility:
// this script never installs anything; run `pnpm install` yourself first).
// Exit code 0 when every hard check passes. Soft passes (a relayer route that is not deployed yet, a host
// that blocks bots) are labelled on their line and in the summary and never fail the run. No key is
// needed. Nothing is signed or spent. Note: on a cold target/ the escrow tests still download the
// near-sandbox binary once, which is cargo's doing, not this script's.
//
// Layout it checks (the monorepo, not the former standalone repository):
//   contracts/lumen-drop-near/contract   the NEAR escrow crate (cargo test: unit + sandbox suites)
//   packages/near                        @lumenia/near: test, typecheck, and the tests' own typecheck
//   apps/web                             @lumenia/web: test:near and test:agentmcp
//   apps/sponsor                         @lumenia/sponsor: test:near-relay
//   apps/agent-market                    @lumenia/agent-market: test, build, dry-run
// A script that is not there yet is reported as FAIL "script missing", never as a crash.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const args = new Set(argv);
const STEPS = ["contract", "near", "web", "sponsor", "agent-market", "agentmcp", "live"];
const ALIASES = { relayer: "sponsor", mcp: "agentmcp" };
const onlyIdx = argv.indexOf("--only");
let only = onlyIdx > -1 ? argv[onlyIdx + 1] : null;
if (only && ALIASES[only]) only = ALIASES[only];
const offline = args.has("--offline");
const liveOnly = args.has("--live-only");

if (args.has("--help") || args.has("-h")) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").filter((l) => l.startsWith("//")).map((l) => l.slice(3)).join("\n"));
  process.exit(0);
}
if (onlyIdx > -1 && (!only || !STEPS.includes(only))) {
  console.error(`--only needs one of: ${STEPS.join(", ")} (aliases: relayer -> sponsor, mcp -> agentmcp)`);
  process.exit(2);
}
if (offline && (liveOnly || only === "live")) {
  console.error("--offline and --live-only (or --only live) leave nothing to run");
  process.exit(2);
}
if (args.has("--skip-install")) console.log("note: --skip-install accepted; this script never installs anything anyway");

const CONTRACT_ID = process.env.LUMENIA_CONTRACT_ID || "lumenia-near.testnet";
const RPC = process.env.NEAR_RPC_URL || "https://test.rpc.fastnear.com";
const RELAYER_HEALTH = healthUrl(process.env.RELAYER_URL || "https://lumenia-sponsor.avakit.workers.dev/near/health", "/near/health");
const LEGACY_RELAYER_HEALTH = healthUrl(process.env.LEGACY_RELAYER_URL || "https://lumenia-near-relayer.avakit.workers.dev/health", "/health");
const SITE = (process.env.SITE_URL || "https://getlumenia.com").replace(/\/+$/, "");
const SITE_PATHS = ["/near", "/c/near"];
const FETCH_TIMEOUT_MS = 20_000;

function healthUrl(raw, defaultPath) {
  // Accept a bare origin as well as the full health URL.
  try {
    const u = new URL(raw);
    if (u.pathname === "/" || u.pathname === "") u.pathname = defaultPath;
    return u.toString();
  } catch {
    return raw;
  }
}

// ---------- bookkeeping ----------
const results = [];
const t0 = Date.now();
function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}
function soft(name, detail) {
  results.push({ name, status: "SOFT", detail });
  console.log(`PASS  ${name}  (soft: ${detail})`);
}
function section(title) {
  console.log(`\n== ${title}`);
}
function want(step) {
  return !only || only === step;
}
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}
function tail(out, n) {
  return stripAnsi(out).split("\n").filter((l) => l.trim()).slice(-n).join("\n");
}
function lastLines(out, n) {
  return stripAnsi(out).split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).join(" | ").slice(0, 300);
}

// ---------- processes ----------
const cargoBin = join(homedir(), ".cargo", "bin");
const childEnv = {
  ...process.env,
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  // The node that runs this script leads the PATH: an agent often starts it by absolute path from a shell
  // that has no node at all, and every bin shim under node_modules/.bin needs one. cargo (and `cargo near`,
  // which the sandbox tests spawn) may live only in ~/.cargo/bin in a non-login shell.
  PATH: [dirname(process.execPath), process.env.PATH || "", existsSync(cargoBin) ? cargoBin : ""].filter(Boolean).join(delimiter),
};
function run(cmd, cmdArgs, cwd) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: "utf8",
    env: childEnv,
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { code: 1, out: String(r.error.message || r.error) };
  return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}
function has(cmd) {
  return run(process.platform === "win32" ? "where" : "which", [cmd], root).code === 0;
}
// pnpm: the one on PATH, else the corepack copy this repo pins (packageManager pnpm@9.12.0), else npx fetches it.
function resolvePnpm() {
  if (has("pnpm")) return { cmd: "pnpm", pre: [], how: "pnpm on PATH" };
  const corepack = join(homedir(), ".cache", "node", "corepack", "v1", "pnpm", "9.12.0", "bin", "pnpm.cjs");
  if (existsSync(corepack)) return { cmd: process.execPath, pre: [corepack], how: `node ${corepack}` };
  return { cmd: "npx", pre: ["-y", "pnpm@9.12.0"], how: "npx -y pnpm@9.12.0" };
}
const pnpm = resolvePnpm();
function pnpmRun(cwd, ...rest) {
  return run(pnpm.cmd, [...pnpm.pre, ...rest], cwd);
}
function resolveCargo() {
  if (has("cargo")) return "cargo";
  const local = join(cargoBin, process.platform === "win32" ? "cargo.exe" : "cargo");
  return existsSync(local) ? local : null;
}
function readScripts(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts || {};
  } catch {
    return null;
  }
}
function testDetail(out) {
  const clean = stripAnsi(out);
  const vitest = clean.match(/Tests\s+(\d+) passed/);
  if (vitest) return `${vitest[1]} tests`;
  const ratio = [...clean.matchAll(/\b(\d+)\s*\/\s*(\d+)\b/g)].pop();
  if (ratio) return `${ratio[1]}/${ratio[2]}`;
  return lastLines(clean, 1).slice(0, 100);
}

// ---------- offline gate ----------
const TS_STEPS = [
  { step: "near", dir: "packages/near", name: "@lumenia/near", scripts: ["test", "typecheck"] },
  { step: "web", dir: "apps/web", name: "@lumenia/web", scripts: ["test:near"] },
  { step: "sponsor", dir: "apps/sponsor", name: "@lumenia/sponsor", scripts: ["test:near-relay"] },
  { step: "agent-market", dir: "apps/agent-market", name: "@lumenia/agent-market", scripts: ["test", "build", "dry-run"] },
  { step: "agentmcp", dir: "apps/web", name: "@lumenia/web", scripts: ["test:agentmcp"] },
];
const runOffline = !liveOnly && only !== "live";
const wantsTs = TS_STEPS.some((p) => want(p.step));

if (runOffline) {
  section("Toolchain");
  const node = Number(process.versions.node.split(".")[0]);
  record("node >= 22", node >= 22, `node ${process.versions.node}`);
  if (wantsTs) {
    const pv = pnpmRun(root, "--version");
    record("pnpm available", pv.code === 0, pv.code === 0 ? `pnpm ${lastLines(pv.out, 1)} via ${pnpm.how}` : `${pnpm.how} failed: ${lastLines(pv.out, 2)}`);
  }
  const cargo = want("contract") ? resolveCargo() : null;
  if (want("contract")) {
    // Version read from inside the crate, so rustup reports the toolchain rust-toolchain.toml pins (1.95.0), not the default one.
    const crateDir = join(root, "contracts", "lumen-drop-near");
    record("cargo available", !!cargo, cargo ? lastLines(run(cargo, ["--version"], existsSync(crateDir) ? crateDir : root).out, 1) : "install Rust (rustup); contracts/lumen-drop-near/rust-toolchain.toml pins 1.95.0");
    if (cargo) {
      const cn = run(cargo, ["near", "--version"], root);
      record("cargo-near available (the sandbox tests build the wasm through it)", cn.code === 0, cn.code === 0 ? lastLines(cn.out, 1) : "install: cargo install cargo-near --locked (0.23.0 is the recorded version)");
    }
  }

  if (want("contract")) {
    section("contracts/lumen-drop-near/contract (Rust): unit tests + sandbox tests");
    const cwd = join(root, "contracts", "lumen-drop-near", "contract");
    if (!existsSync(join(cwd, "Cargo.toml"))) {
      record("contract crate present", false, cwd);
    } else if (!cargo) {
      record("contract tests (cargo test)", false, "cargo missing");
    } else {
      const r = run(cargo, ["test"], cwd);
      const oks = [...stripAnsi(r.out).matchAll(/test result: ok\. (\d+) passed/g)].map((m) => Number(m[1]));
      const failedSuites = (stripAnsi(r.out).match(/test result: FAILED/g) || []).length;
      const total = oks.reduce((a, b) => a + b, 0);
      const ok = r.code === 0 && failedSuites === 0 && total > 0;
      record("contract tests (cargo test)", ok, ok ? `${total} tests ok (${oks.filter(Boolean).join(" + ")})` : `exit ${r.code}, ${failedSuites} suite(s) failed, ${total} passed`);
      if (!ok) console.log(tail(r.out, 40));
    }
  }

  for (const p of TS_STEPS) {
    if (!want(p.step)) continue;
    const cwd = join(root, p.dir);
    section(`${p.dir} (${p.name}): ${p.scripts.join(", ")}`);
    const scripts = readScripts(cwd);
    if (!scripts) {
      record(`${p.name} present`, false, `no package.json in ${p.dir}`);
      continue;
    }
    let buildFailed = false;
    for (const s of p.scripts) {
      const label = `${p.name} ${s}`;
      if (!scripts[s]) {
        record(label, false, "script missing");
        continue;
      }
      if (s === "dry-run" && buildFailed) {
        record(label, false, "not run: build failed");
        continue;
      }
      const r = pnpmRun(root, "--filter", p.name, s);
      let detail = "";
      if (r.code === 0) {
        if (s.startsWith("test")) detail = testDetail(r.out);
        else if (s === "dry-run") detail = "deliverable rendered from examples/brief.md";
      } else {
        detail = `exit ${r.code}: ${lastLines(r.out, 6)}`;
        if (s === "build") buildFailed = true;
      }
      record(label, r.code === 0, detail);
    }
    // The near package's tests are typechecked by their own config (the package tsconfig covers src only).
    if (p.step === "near" && existsSync(join(cwd, "tsconfig.test.json"))) {
      const r = pnpmRun(root, "--filter", p.name, "exec", "tsc", "--noEmit", "-p", "tsconfig.test.json");
      record(`${p.name} typecheck of the tests (tsconfig.test.json)`, r.code === 0, r.code === 0 ? "" : `exit ${r.code}: ${lastLines(r.out, 6)}`);
    }
  }
}

// ---------- live, read-only ----------
async function httpGet(url, accept) {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { accept, "user-agent": "lumenia-near-verify/2 (ops/near-verify.mjs; read-only)" },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, text, json, url: res.url };
}
async function probe(url, accept = "application/json") {
  try {
    return await httpGet(url, accept);
  } catch (e) {
    return { status: 0, text: "", json: null, url, error: String(e?.cause?.message || e?.message || e) };
  }
}
function describe(p) {
  if (p.error) return `unreachable (${p.error})`;
  const body = p.json ? JSON.stringify(p.json).slice(0, 80) : p.text.slice(0, 60).replace(/\s+/g, " ");
  return `HTTP ${p.status}${body ? " " + body : ""}`;
}
async function rpcView(method, argsObj = {}) {
  const body = {
    jsonrpc: "2.0",
    id: "verify",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: CONTRACT_ID,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(argsObj)).toString("base64"),
    },
  };
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 200));
  return JSON.parse(Buffer.from(json.result.result).toString("utf8"));
}
function errMsg(e) {
  return String(e?.cause?.message || e?.message || e);
}

async function liveChecks() {
  section(`Live, read-only (NEAR testnet via ${RPC}; nothing is signed)`);
  try {
    const cfg = await rpcView("get_config");
    const ok = cfg && typeof cfg === "object" && "token_id" in cfg && "starter_yocto" in cfg;
    record(`${CONTRACT_ID} get_config`, ok, ok ? `token ${String(cfg.token_id).slice(0, 8)}..., starter ${Number(BigInt(cfg.starter_yocto) / 10n ** 21n) / 1000} NEAR, max expiry ${cfg.max_expiry_s} s, paused ${cfg.paused}` : JSON.stringify(cfg).slice(0, 120));
  } catch (e) {
    record(`${CONTRACT_ID} get_config`, false, errMsg(e));
  }
  try {
    const st = await rpcView("get_stats");
    const ok = st && typeof st === "object" && "drops_created" in st;
    record(`${CONTRACT_ID} get_stats`, ok, ok ? `${st.drops_created} created, ${st.drops_claimed} claimed, ${st.drops_reclaimed} returned, ${st.open_drops} open, pool ${Number(BigInt(st.pool_balance) / 10n ** 22n) / 100} NEAR` : JSON.stringify(st).slice(0, 120));
  } catch (e) {
    record(`${CONTRACT_ID} get_stats`, false, errMsg(e));
  }
  try {
    const page = await rpcView("get_drops", { from_index: 0, limit: 5 });
    record(`${CONTRACT_ID} get_drops (public ledger)`, Array.isArray(page), `${Array.isArray(page) ? page.length : 0} newest rows read`);
  } catch (e) {
    record(`${CONTRACT_ID} get_drops (public ledger)`, false, errMsg(e));
  }

  // The relayer: the sponsor Worker's /near/health once the coordinator deploys it; until then the Worker
  // answers 503 near_not_configured (secrets not set) or 404 (route not deployed), and the legacy standalone
  // relayer is probed as a fallback so the run still says whether a relayer answers for this escrow.
  const name = `relayer health ${RELAYER_HEALTH}`;
  const primary = await probe(RELAYER_HEALTH);
  const healthy = (p) => p.status === 200 && p.json && p.json.ok === true;
  const summary = (p) => `${p.json?.relayer?.accountId ?? "?"}, ${p.json?.relayer?.balanceNear ?? "?"} NEAR, storage ${p.json?.storage ?? "?"}, version ${p.json?.version ?? "?"}`;
  if (healthy(primary)) {
    const escrow = primary.json.escrowId;
    if (escrow && escrow !== CONTRACT_ID) record(name, false, `relayer serves escrow ${escrow}, expected ${CONTRACT_ID}`);
    else record(name, true, summary(primary));
  } else if (primary.status === 503 && primary.json?.error === "near_not_configured") {
    soft(name, "relayer not configured yet: 503 near_not_configured until the NEAR secrets are set on the Worker");
  } else if (primary.status === 404 || primary.status === 0) {
    const legacy = await probe(LEGACY_RELAYER_HEALTH);
    if (healthy(legacy) && legacy.json.escrowId === CONTRACT_ID) {
      soft(name, `route not deployed yet (${describe(primary)}); legacy relayer ${LEGACY_RELAYER_HEALTH} answers: ${summary(legacy)}`);
    } else {
      record(name, false, `${describe(primary)}; legacy ${LEGACY_RELAYER_HEALTH}: ${describe(legacy)}`);
    }
  } else {
    record(name, false, describe(primary));
  }

  for (const path of SITE_PATHS) {
    const pageName = `hosted page ${SITE}${path}`;
    const p = await probe(SITE + path, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8");
    if (p.error) record(pageName, false, `unreachable (${p.error})`);
    else if (p.status === 200) record(pageName, true, `200, ${p.text.length} bytes${/lumenia/i.test(p.text) ? ", mentions Lumenia" : ""}`);
    else if (p.status === 403 || p.status === 429) soft(pageName, `HTTP ${p.status}: blocked by bot protection, open it in a browser`);
    else if (p.status === 404) record(pageName, false, "404: route not deployed");
    else record(pageName, false, `HTTP ${p.status}`);
  }
}
if (!offline && (liveOnly || !only || only === "live")) await liveChecks();

// ---------- summary ----------
const failed = results.filter((r) => r.status === "FAIL");
const softs = results.filter((r) => r.status === "SOFT");
const passed = results.length - failed.length;
const secs = Math.round((Date.now() - t0) / 1000);
const softNote = softs.length ? ` (${softs.length} soft)` : "";
console.log(`\n${failed.length === 0 ? "ALL GREEN" : "FAILURES: " + failed.length}  ${passed}/${results.length} checks passed${softNote} in ${secs} s`);
for (const r of failed) console.log(`  - FAIL ${r.name}${r.detail ? ": " + r.detail : ""}`);
for (const r of softs) console.log(`  - soft ${r.name}: ${r.detail}`);
process.exit(failed.length === 0 ? 0 : 1);
