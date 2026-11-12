#!/usr/bin/env node
// Checks the NEAR rail of this monorepo the way a judge or a coding agent would:
//   pnpm near:verify            prerequisites, the offline gate (escrow crate tests, the near package, the NEAR
//                               suites of web / sponsor / agent-market, the agent MCP self-test), then the live
//                               read-only checks
//   pnpm near:verify:offline    the same without any network call of its own
//   pnpm near:verify:live       only the live read-only checks (no tests, a few seconds)
// Flags: --offline (no live checks), --live-only (no offline steps), --only <step> runs just that step (one of
// contract, near, web, sponsor, agent-market, agentmcp, live), --skip-install (accepted for compatibility:
// this script never installs anything; run `pnpm install` yourself first).
// Exit code 0 when every hard check passes. Soft passes (a relayer route that is not deployed yet, a host
// that blocks bots, a proof transaction that ends in success while a receipt inside it failed) are labelled
// on their line and in the summary and never fail the run. No key is needed. Nothing is signed or spent.
// The last line gives the total runtime.
//
// Prerequisites are reported first, with an install hint on every missing line: node >= 22; pnpm (the
// TypeScript steps); cargo and cargo-near (the contract step: its sandbox tests shell out to
// `cargo near build`, so without cargo-near that step FAILS with the hint and only the unit tests run);
// near-cli-rs (optional: only the `near contract ...` command in NEAR.md uses it; never fails the run).
// First run of the contract step: cargo compiles the Rust test dependencies and near-sandbox downloads the
// nearcore 2.14.0 sandbox binary (about 70 MB): about 2 GB in contracts/lumen-drop-near/target in all, and
// about 3 minutes on an Apple M4 with the crates already in ~/.cargo (measured 2026-11-12: 165 s, 2.0 GB);
// later runs reuse both and take about 40 s. That download is cargo's doing, not this script's.
//
// The live section reads the escrow's views, checks that the testnet and mainnet escrows both run the code hash
// NEAR.md documents (after a full run it also says whether this machine's build of the wasm reproduces it: a
// non-reproducible build can differ across toolchains, so that line is a NOTE, never a FAIL), reads the relayer's
// health and the hosted pages, then checks every
// transaction hash in NEAR.md's proof tables over RPC (`tx` with wait_until NONE). The hashes are parsed from
// NEAR.md at run time, so the check follows the document: base58 hashes of 32 bytes in table rows under a
// heading that says "proof"; such a row is a mainnet one under a heading that says "mainnet" (or when it links
// the hash on a mainnet explorer), a testnet one otherwise. A hash passes only when its final status is
// SuccessValue or SuccessReceiptId. A regular RPC node keeps only its last few epochs (about a day or two), so
// a hash it no longer knows is asked again from the archival node of the same network.
// Endpoints: testnet https://test.rpc.fastnear.com (NEAR_RPC_URL), archival https://archival-rpc.testnet.fastnear.com
// (NEAR_ARCHIVAL_RPC_URL); mainnet https://rpc.mainnet.fastnear.com (NEAR_MAINNET_RPC_URL), archival
// https://archival-rpc.mainnet.fastnear.com (NEAR_MAINNET_ARCHIVAL_RPC_URL). NEAR_MD points at another copy of the document.
//
// Layout it checks (the monorepo, not the former standalone repository):
//   contracts/lumen-drop-near/contract   the NEAR escrow crate (cargo test: unit + sandbox suites)
//   packages/near                        @lumenia/near: test, typecheck, and the tests' own typecheck
//   apps/web                             @lumenia/web: test:near and test:agentmcp
//   apps/sponsor                         @lumenia/sponsor: test:near-relay
//   apps/agent-market                    @lumenia/agent-market: test, build, dry-run
//   NEAR.md                              the proof tables the live section checks on chain
// A script that is not there yet is reported as FAIL "script missing", never as a crash.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, relative } from "node:path";
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
const SITE_PATHS = ["/try/send", "/claim", "/ledger"];
const NEAR_MD = process.env.NEAR_MD || join(root, "NEAR.md");
// The proof checks look a hash up by hash. `tx` also wants a sender_account_id, which only picks the shard to
// ask: an RPC node tracks every shard, so any valid account of the network works and the answer carries the
// real signer.
const NETWORKS = {
  testnet: {
    rpc: RPC,
    archival: process.env.NEAR_ARCHIVAL_RPC_URL || "https://archival-rpc.testnet.fastnear.com",
    sender: CONTRACT_ID,
  },
  mainnet: {
    rpc: process.env.NEAR_MAINNET_RPC_URL || "https://rpc.mainnet.fastnear.com",
    archival: process.env.NEAR_MAINNET_ARCHIVAL_RPC_URL || "https://archival-rpc.mainnet.fastnear.com",
    sender: process.env.LUMENIA_MAINNET_CONTRACT_ID || "lumenia.near",
  },
};
const FETCH_TIMEOUT_MS = 20_000;
const UA = "lumenia-near-verify/3 (ops/near-verify.mjs; read-only)";

// Install hints, printed on every missing prerequisite and on the step it stops.
const HINT = {
  node: "install Node 22 or newer (CI runs 24): https://nodejs.org, or `nvm install 24`",
  pnpm: "`corepack enable` (the repo pins pnpm@9.12.0), or run every command with `npx -y pnpm@9.12.0`",
  cargo: "install Rust with rustup (https://rustup.rs); contracts/lumen-drop-near/rust-toolchain.toml pins 1.95.0 and rustup fetches it on first use",
  cargoNear:
    "`cargo install cargo-near --locked --version 0.23.0`, or the release installer: curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/download/cargo-near-v0.23.0/cargo-near-installer.sh | sh",
  nearCli:
    "`cargo install near-cli-rs --locked --version 0.31.1`, or `npm install -g near-cli-rs@0.31.1`, or curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/download/v0.31.1/near-cli-rs-installer.sh | sh",
};

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
const results = []; // checks: PASS / FAIL / SOFT
const missingTools = []; // prerequisites that are not installed (not checks themselves; the step that needs one fails)
const t0 = Date.now();
let builtCodeHash = null; // the escrow wasm's code hash after the contract step, when it built one
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Base58 (Bitcoin alphabet), the encoding NEAR prints code hashes in.
function base58(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
function record(name, ok, detail = "") {
  results.push({ name, status: ok ? "PASS" : "FAIL", detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
}
function soft(name, detail) {
  results.push({ name, status: "SOFT", detail });
  console.log(`PASS  ${name}  (soft: ${detail})`);
}
function missing(name, detail, optional = false) {
  missingTools.push({ name, detail, optional });
  console.log(`MISSING  ${name}  (${detail})`);
}
function note(text) {
  console.log(`NOTE  ${text}`);
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
function duration(ms) {
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

// ---------- processes ----------
// rustup installs cargo and the cargo-* subcommands into $CARGO_HOME/bin (default ~/.cargo/bin).
const cargoBin = join(process.env.CARGO_HOME || join(homedir(), ".cargo"), "bin");
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
// `cargo near --version` prints "cargo-near-near 0.23.0"; without the subcommand cargo answers "no such command".
function detectCargoNear(cargo, cwd) {
  const r = run(cargo, ["near", "--version"], cwd);
  const m = stripAnsi(r.out).match(/cargo-near(?:-near)?\s+v?(\d+\.\d+\.\d+\S*)/);
  if (r.code === 0 && m) return { ok: true, version: `cargo-near ${m[1]}` };
  return { ok: false, why: r.code === 0 ? `\`cargo near --version\` printed "${lastLines(r.out, 1).slice(0, 80)}"` : "not found (`cargo near` is not a cargo subcommand here)" };
}
// near-cli-rs installs a binary named `near`; the legacy JS near-cli uses the same name but has no `near contract`.
function detectNearCli() {
  const r = run("near", ["--version"], root);
  const m = stripAnsi(r.out).match(/near-cli-rs\s+v?(\d+\.\d+\.\d+\S*)/);
  if (r.code === 0 && m) return { ok: true, version: `near-cli-rs ${m[1]}` };
  if (r.code === 0) return { ok: false, why: `the \`near\` on PATH is not near-cli-rs (it printed "${lastLines(r.out, 1).slice(0, 60)}"; the legacy JS near-cli has no \`near contract\`)` };
  return { ok: false, why: "not found" };
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
function cargoCounts(out) {
  const clean = stripAnsi(out);
  const oks = [...clean.matchAll(/test result: ok\. (\d+) passed/g)].map((m) => Number(m[1]));
  const failedSuites = (clean.match(/test result: FAILED/g) || []).length;
  return { oks, failedSuites, total: oks.reduce((a, b) => a + b, 0) };
}

// ---------- prerequisites ----------
const TS_STEPS = [
  { step: "near", dir: "packages/near", name: "@lumenia/near", scripts: ["test", "typecheck"] },
  { step: "web", dir: "apps/web", name: "@lumenia/web", scripts: ["test:near"] },
  { step: "sponsor", dir: "apps/sponsor", name: "@lumenia/sponsor", scripts: ["test:near-relay"] },
  { step: "agent-market", dir: "apps/agent-market", name: "@lumenia/agent-market", scripts: ["test", "build", "dry-run"] },
  { step: "agentmcp", dir: "apps/web", name: "@lumenia/web", scripts: ["test:agentmcp"] },
];
const runOffline = !liveOnly && only !== "live";
const runLive = !offline && (liveOnly || !only || only === "live");
const wantsTs = runOffline && TS_STEPS.some((p) => want(p.step));
const wantsContract = runOffline && want("contract");
const crateRoot = join(root, "contracts", "lumen-drop-near");

section("Prerequisites (an install hint on every missing line)");
const nodeMajor = Number(process.versions.node.split(".")[0]);
record("node >= 22", nodeMajor >= 22, nodeMajor >= 22 ? `node ${process.versions.node}` : `node ${process.versions.node}; ${HINT.node}`);
if (wantsTs) {
  const pv = pnpmRun(root, "--version");
  record("pnpm", pv.code === 0, pv.code === 0 ? `pnpm ${lastLines(pv.out, 1)} via ${pnpm.how}` : `${pnpm.how} failed: ${lastLines(pv.out, 2)}; ${HINT.pnpm}`);
}
const cargo = wantsContract ? resolveCargo() : null;
let cargoNear = null;
if (wantsContract) {
  // Read from inside the crate, so rustup reports the toolchain rust-toolchain.toml pins (1.95.0), not the default one.
  const cwd = existsSync(crateRoot) ? crateRoot : root;
  if (cargo) record("cargo", true, lastLines(run(cargo, ["--version"], cwd).out, 1));
  else missing("cargo (the contract step)", `not found; ${HINT.cargo}`);
  if (cargo) {
    cargoNear = detectCargoNear(cargo, cwd);
    const label = "cargo-near (the contract's sandbox tests shell out to `cargo near build`)";
    if (cargoNear.ok) record(label, true, `${cargoNear.version}; 0.23.0 is the recorded version`);
    else missing(label, `${cargoNear.why}; install: ${HINT.cargoNear}`);
  }
}
const nearCli = detectNearCli();
const nearCliLabel = "near-cli-rs (optional: only the `near contract ...` command in NEAR.md uses it)";
if (nearCli.ok) record(nearCliLabel, true, nearCli.version);
else missing(nearCliLabel, `${nearCli.why}; nothing in this script needs it; install: ${HINT.nearCli}`, true);
if (wantsContract) {
  note(
    "the first run of the contract step compiles the Rust test dependencies and downloads the nearcore 2.14.0 sandbox: " +
      "about 2 GB in contracts/lumen-drop-near/target and about 3 minutes (measured with the crates already cached); " +
      "later runs reuse both",
  );
}

// ---------- offline gate ----------
if (runOffline) {
  if (want("contract")) {
    section("contracts/lumen-drop-near/contract (Rust): unit tests + sandbox tests");
    const cwd = join(crateRoot, "contract");
    const started = Date.now();
    if (!existsSync(join(cwd, "Cargo.toml"))) {
      record("contract crate present", false, cwd);
    } else if (!cargo) {
      record("contract tests (cargo test)", false, `cargo missing; ${HINT.cargo}`);
    } else if (!cargoNear?.ok) {
      // The unit tests need no cargo-near: run them, then fail the sandbox suite with the install hint
      // instead of letting it die inside the test harness on a missing subcommand.
      const r = run(cargo, ["test", "--lib"], cwd);
      const c = cargoCounts(r.out);
      const ok = r.code === 0 && c.failedSuites === 0 && c.total > 0;
      record("contract unit tests (cargo test --lib, no cargo-near needed)", ok, ok ? `${c.total} tests ok, ${duration(Date.now() - started)}` : `exit ${r.code}, ${c.failedSuites} suite(s) failed, ${c.total} passed`);
      if (!ok) console.log(tail(r.out, 40));
      record(
        "contract sandbox tests (tests/sandbox.rs)",
        false,
        `not run: cargo-near is missing, and these tests build the three wasm files with \`cargo near build\`; install: ${HINT.cargoNear}`,
      );
    } else {
      const r = run(cargo, ["test"], cwd);
      const c = cargoCounts(r.out);
      const ok = r.code === 0 && c.failedSuites === 0 && c.total > 0;
      record("contract tests (cargo test)", ok, ok ? `${c.total} tests ok (${c.oks.filter(Boolean).join(" + ")}), ${duration(Date.now() - started)}` : `exit ${r.code}, ${c.failedSuites} suite(s) failed, ${c.total} passed`);
      if (!ok) console.log(tail(r.out, 40));
      const wasm = join(crateRoot, "target", "near", "lumenia_drop", "lumenia_drop.wasm");
      if (ok && existsSync(wasm)) {
        builtCodeHash = base58(createHash("sha256").update(readFileSync(wasm)).digest());
        note(`the escrow wasm the sandbox tests built has code hash ${builtCodeHash} (the live section compares it with the deployed code)`);
      }
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
    headers: { accept, "user-agent": UA },
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
// One JSON-RPC call. Throws on a transport error, a timeout or a body that is not JSON (a rate-limit page).
async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status} ${text.slice(0, 60).replace(/\s+/g, " ")}`.trim());
  }
}
async function rpcView(method, argsObj = {}) {
  const json = await rpcCall(RPC, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: CONTRACT_ID,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(argsObj)).toString("base64"),
  });
  if (json.error) throw new Error(JSON.stringify(json.error).slice(0, 200));
  return JSON.parse(Buffer.from(json.result.result).toString("utf8"));
}
function errMsg(e) {
  return String(e?.cause?.message || e?.message || e);
}

// ----- proof transactions, parsed from NEAR.md -----
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Length(s) {
  let n = 0n;
  for (const ch of s) {
    const v = BASE58.indexOf(ch);
    if (v < 0) return -1;
    n = n * 58n + BigInt(v);
  }
  let bytes = 0;
  for (; n > 0n; n >>= 8n) bytes++;
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  return bytes + zeros;
}
function plainCell(cell) {
  const s = cell.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[`*_]/g, "").replace(/\s+/g, " ").trim();
  if (s.length <= 64) return s;
  const cut = s.slice(0, 64);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 64)}...`;
}
// A 32-byte base58 string standing on its own in a table row (not the tail of "ed25519:...", not inside a
// longer word or a hex id) under a heading that says "proof".
function proofHashes(markdown) {
  const CANDIDATE = /(?<![0-9A-Za-z:_-])[1-9A-HJ-NP-Za-km-z]{43,44}(?![0-9A-Za-z_-])/g;
  const found = new Map();
  let heading = "";
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      heading = h[1];
      continue;
    }
    if (!/proof/i.test(heading) || !/^\s*\|/.test(line)) continue;
    const hashes = [...line.matchAll(CANDIDATE)].map((m) => m[0]).filter((s) => base58Length(s) === 32);
    if (hashes.length === 0) continue;
    const what = plainCell(line.trim().replace(/^\|/, "").split("|")[0] || "");
    hashes.forEach((hash, i) => {
      if (found.has(hash)) return;
      // An explorer link next to the hash names its network; otherwise the heading does.
      const host = new RegExp(`([a-z0-9.-]+)/(?:txns|transactions|tx)/${hash}`, "i").exec(line)?.[1] || "";
      const network = host ? (/testnet/i.test(host) ? "testnet" : "mainnet") : /mainnet/i.test(heading) ? "mainnet" : "testnet";
      found.set(hash, { hash, network, what: hashes.length > 1 ? `${what} (${i + 1} of ${hashes.length})` : what });
    });
  }
  return [...found.values()];
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The regular node first, then the archival one: a regular node keeps only its last few epochs, so an older
// proof answers UNKNOWN_TRANSACTION there. A transport error or a rate-limit page is retried once.
async function txLookup(hash, network) {
  const net = NETWORKS[network];
  const notes = [];
  for (const [label, url] of [["regular", net.rpc], ["archival", net.archival]]) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const j = await rpcCall(url, "tx", { tx_hash: hash, sender_account_id: net.sender, wait_until: "NONE" });
        if (j.result) return { result: j.result, via: label };
        const name = j.error?.cause?.name || j.error?.name || "error";
        notes.push(`${label} ${new URL(url).host}: ${name}`);
        if (name === "UNKNOWN_TRANSACTION" || attempt === 2) break;
      } catch (e) {
        notes.push(`${label} ${new URL(url).host}: ${errMsg(e)}`);
        if (attempt === 2) break;
      }
      await sleep(1000);
    }
  }
  return { error: notes.join("; ") };
}
function returnValue(b64) {
  const s = Buffer.from(String(b64 || ""), "base64").toString("utf8");
  if (!s) return "(empty)";
  if (/[^\x20-\x7e]/.test(s)) return `(${Buffer.from(String(b64), "base64").length} bytes)`;
  return s.length > 24 ? `${s.slice(0, 24)}...` : s;
}
// PASS only when the final status is SuccessValue or SuccessReceiptId. A receipt that failed inside a
// transaction that still ends in success (a refund path) is reported as a soft pass so it gets a look.
function judgeTx(res, hash) {
  const st = res.status;
  const outcomes = Array.isArray(res.receipts_outcome) ? res.receipts_outcome : [];
  const failedInside = outcomes.filter((o) => o?.outcome?.status && typeof o.outcome.status === "object" && "Failure" in o.outcome.status);
  const signer = res.transaction?.signer_id ?? "?";
  if (res.transaction?.hash && res.transaction.hash !== hash) return { ok: false, detail: `the RPC answered for another transaction, ${res.transaction.hash}` };
  if (st && typeof st === "object" && ("SuccessValue" in st || "SuccessReceiptId" in st)) {
    const what = "SuccessValue" in st ? `SuccessValue ${returnValue(st.SuccessValue)}` : `SuccessReceiptId ${String(st.SuccessReceiptId).slice(0, 8)}...`;
    const base = `${what}, signer ${signer}, ${outcomes.length} receipts`;
    if (failedInside.length) {
      return { ok: true, soft: true, detail: `${base}, ${failedInside.length} failed inside (${failedInside.map((o) => o.outcome.executor_id).join(", ")}) although the final status is a success` };
    }
    return { ok: true, detail: `${base}, none failed` };
  }
  const shown = st && typeof st === "object" ? JSON.stringify(st).slice(0, 160) : String(st);
  return { ok: false, detail: `final status ${shown} (${res.final_execution_status ?? "?"}), signer ${signer}` };
}
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

async function proofChecks() {
  const rel = relative(root, NEAR_MD);
  const doc = rel && !rel.startsWith("..") ? rel : NEAR_MD;
  section(`Proof transactions in ${doc}: each hash over RPC (tx, wait_until NONE), PASS only on SuccessValue / SuccessReceiptId`);
  let markdown;
  try {
    markdown = readFileSync(NEAR_MD, "utf8");
  } catch (e) {
    record(`proof transactions in ${doc}`, false, `cannot read it: ${errMsg(e)}`);
    return;
  }
  const proofs = proofHashes(markdown);
  if (proofs.length === 0) {
    record(`proof transactions in ${doc}`, false, "no transaction hash found in a table row under a heading that says \"proof\"");
    return;
  }
  const byNet = (n) => proofs.filter((p) => p.network === n).length;
  console.log(`${proofs.length} hash${proofs.length === 1 ? "" : "es"} parsed from ${doc}: ${byNet("testnet")} testnet (${new URL(NETWORKS.testnet.rpc).host}), ${byNet("mainnet")} mainnet (${new URL(NETWORKS.mainnet.rpc).host})`);
  const checked = await mapPool(proofs, 4, async (p) => ({ p, r: await txLookup(p.hash, p.network) }));
  for (const { p, r } of checked) {
    const name = `${p.network} tx ${p.hash} (${p.what})`;
    if (r.error) {
      record(name, false, `no answer: ${r.error}`);
      continue;
    }
    const v = judgeTx(r.result, p.hash);
    const detail = v.detail + (r.via === "archival" ? "; answered by the archival node" : "");
    if (v.ok && v.soft) soft(name, detail);
    else record(name, v.ok, detail);
  }
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
  // The deployed code: the testnet and the mainnet escrow must both run the code hash NEAR.md documents.
  try {
    const documented = (readFileSync(NEAR_MD, "utf8").match(/code hash ([1-9A-HJ-NP-Za-km-z]{43,44})/) || [])[1];
    const codeHash = async (url, accountId) => {
      const j = await rpcCall(url, "query", { request_type: "view_account", finality: "final", account_id: accountId });
      if (j.error) throw new Error(`${accountId}: ${JSON.stringify(j.error).slice(0, 160)}`);
      return j.result.code_hash;
    };
    const [t, m] = await Promise.all([codeHash(RPC, CONTRACT_ID), codeHash(NETWORKS.mainnet.rpc, NETWORKS.mainnet.sender)]);
    record(`deployed code: ${CONTRACT_ID} and ${NETWORKS.mainnet.sender} run the code hash NEAR.md documents`, !!documented && t === documented && m === documented, `testnet ${t}, mainnet ${m}, NEAR.md ${documented ?? "none found"}`);
    if (builtCodeHash) {
      note(
        builtCodeHash === documented
          ? `this machine's build of the escrow reproduces the deployed code hash ${documented}`
          : `this machine's build hashes to ${builtCodeHash}, the deployed code to ${documented}: a non-reproducible build can differ across toolchains (the deployed wasm was built with Rust 1.95 and cargo-near 0.23 on macOS)`,
      );
    }
  } catch (e) {
    record("deployed code hash", false, errMsg(e));
  }

  // The relayer: the sponsor Worker's /near/health once the coordinator deploys it; until then the Worker
  // answers 503 near_not_configured (secrets not set) or 404 (route not deployed), and the legacy standalone
  // relayer is probed as a fallback so the run still says whether a relayer answers for this escrow.
  const name = `relayer health ${RELAYER_HEALTH}`;
  const primary = await probe(RELAYER_HEALTH);
  const healthy = (p) => p.status === 200 && p.json && p.json.ok === true;
  const summary = (p) => `${p.json?.relayer?.accountId ?? "?"}, ${p.json?.relayer?.balanceNear ?? "?"} NEAR, storage ${p.json?.storage ?? "?"}, version ${p.json?.version?.id ?? p.json?.version ?? "?"}`;
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

  await proofChecks();
}
if (runLive) await liveChecks();

// ---------- summary ----------
const failed = results.filter((r) => r.status === "FAIL");
const softs = results.filter((r) => r.status === "SOFT");
const passed = results.length - failed.length;
const softNote = softs.length ? ` (${softs.length} soft)` : "";
console.log(`\n${failed.length === 0 ? "ALL GREEN" : "FAILURES: " + failed.length}  ${passed}/${results.length} checks passed${softNote}; total runtime ${duration(Date.now() - t0)}`);
for (const r of failed) console.log(`  - FAIL ${r.name}${r.detail ? ": " + r.detail : ""}`);
for (const r of softs) console.log(`  - soft ${r.name}: ${r.detail}`);
// A missing hard prerequisite already failed the step that needs it, hint included; only optional ones are left to list.
for (const m of missingTools.filter((t) => t.optional)) console.log(`  - missing ${m.name}: ${m.detail}`);
process.exit(failed.length === 0 ? 0 : 1);
