#!/usr/bin/env node
/**
 * Build the Lumenia extension for Chrome and Firefox from one source tree.
 *
 *   node build.mjs            -> dist/chrome, dist/firefox and one zip per browser
 *   node build.mjs --watch    -> rebuild both on change (no zips)
 *   node build.mjs --sources  -> also the sources zip AMO asks for when code is bundled
 *   node build.mjs --e2e-ttl=180 -> dist/e2e-chrome only, links expire after 180 s so the take-back
 *                                  can be proven in one sitting; never zipped, never a store build
 *
 * Three bundles per browser, each a classic IIFE: background.js (Chrome's service worker, Firefox's
 * event page), popup.js, and nothing else; the paste-into-page function is bundled into the
 * background and handed to scripting.executeScript, so there is no content-script file.
 *
 * Why IIFE and no code splitting: a service worker may not use dynamic import() (HTML spec; Chrome
 * throws on it), and apps/web/lib/keystore.ts loads the Argon2id module with one. With splitting
 * off, esbuild inlines that import into the same file.
 *
 * Not minified on purpose. Store reviewers read the package; "submit code as authored where
 * possible" is the review guidance, and the base64 WebAssembly inside hash-wasm is easier to
 * recognise as the library's own when the code around it is readable.
 *
 * The build FAILS if a bundle still reads process.env (a value we forgot to define would be a
 * runtime ReferenceError in a service worker, which has no `process`), or contains eval(,
 * Function( (with or without new), a string passed to a timer or to .constructor(, importScripts(,
 * import(, or HTML assigned from a string, outside the allow-list below; if our own src/ uses
 * innerHTML or dangerouslySetInnerHTML at all; or if a manifest asks for any permission beyond the
 * five, any host beyond the six, an optional permission, a web-accessible resource, a content script
 * or externally_connectable. It prints every http(s) URL found in the output, which is the
 * remote-code scan the Chrome docs recommend.
 */
import { build, context } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(ROOT, "..", "..");
const DIST = path.join(ROOT, "dist");
const args = new Set(process.argv.slice(2));
const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;
const E2E_TTL = (() => {
  const arg = [...args].find((a) => a.startsWith("--e2e-ttl="));
  if (!arg) return null;
  const n = Number(arg.split("=")[1]);
  // 60 s to an hour for the take-back proof; 604800 (the store's own seven days) for screenshot runs.
  if (!Number.isInteger(n) || n < 60 || (n > 3600 && n !== 604800)) {
    throw new Error("--e2e-ttl must be whole seconds between 60 and 3600, or 604800");
  }
  return n;
})();
/** Output folder per target; the end-to-end build never lands where a store zip is made from. */
const outDir = (target) => path.join(DIST, E2E_TTL ? `e2e-${target}` : target);

/** The only hosts the extension talks to. The manifests must list exactly these, and nothing broader. */
export const HOSTS = [
  "https://lumenia-sponsor.avakit.workers.dev/*",
  "https://lumenia-sponsor-mainnet.avakit.workers.dev/*",
  "https://horizon-testnet.stellar.org/*",
  "https://horizon.stellar.org/*",
  "https://soroban-testnet.stellar.org/*",
  "https://mainnet.sorobanrpc.com/*",
];
/**
 * WebAssembly for hash-wasm's Argon2id ('wasm-unsafe-eval'), nothing else runnable, and network
 * access from every extension page and the worker limited to the same six hosts: a library that
 * tried to call anywhere else would be stopped by the browser, not merely by our own good intentions.
 * The popup shows no remote image, embeds no frame and submits no form anywhere (every form handles
 * its submit in script), so those are closed too, along with any <base> that could re-point a URL.
 */
const CSP = `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'self' ${HOSTS.map((h) => h.replace(/\/\*$/, "")).join(" ")}; img-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none';`;

/**
 * Every process.env key the bundled apps/web/lib modules read (grep of their import closure,
 * 2026-10-03). The two mainnet values exist only in apps/sponsor/wrangler.toml and the Vercel env;
 * network.ts defaults them to "" and refuses to hand out a half-configured mainnet, so they are
 * stated here. Undefined keys are defined as undefined, never left to a missing `process`.
 */
const ENV = {
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
  NEXT_PUBLIC_STELLAR_NETWORK: undefined,
  NEXT_PUBLIC_REQUIRE_PHASE2: undefined,
  NODE_ENV: "production",
};

const define = {
  ...Object.fromEntries(
    Object.entries(ENV).map(([k, v]) => [`process.env.${k}`, v === undefined ? "undefined" : JSON.stringify(v)]),
  ),
  __EXT_VERSION__: JSON.stringify(VERSION),
  __LINK_TTL_S__: String(E2E_TTL ?? 7 * 24 * 3600),
  global: "globalThis",
};

/**
 * Patterns a bundle may not contain, with the exact occurrences we have read and accepted. An entry
 * names the file, the snippet and the reason; anything not listed fails the build.
 */
const FORBIDDEN = [
  { name: "process.env", re: /process\.env\b/g },
  { name: "eval(", re: /(?<![\w$.])eval\s*\(/g },
  { name: "new Function(", re: /new\s+Function\s*\(/g },
  { name: "Function(", re: /(?<![\w$.]|new\s+)Function\s*\(/g },
  { name: ".constructor(string)", re: /\.constructor\s*\(\s*["'`]/g },
  { name: "string timer", re: /(?<![\w$.])set(?:Timeout|Interval)\s*\(\s*["'`]/g },
  { name: "importScripts(", re: /importScripts\s*\(/g },
  { name: "dynamic import(", re: /(?<![\w$.])import\s*\(/g },
  { name: "HTML from a string", re: /\.(?:inner|outer)HTML\b|insertAdjacentHTML|document\.write/g },
];
const ALLOWED_OCCURRENCES = [
  {
    file: "popup.js",
    name: "HTML from a string",
    contains: ".__html",
    why: "Preact's own dangerouslySetInnerHTML branch (the library's published file). It runs only for a vnode that passes dangerouslySetInnerHTML, and no Lumenia source does: the build fails on that word under src/ (see sourceGuard).",
  },
];

/** Constructs our own source (src/, not tests) may not use at all, whatever the bundler makes of them. */
const SOURCE_FORBIDDEN = [{ name: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML|\.(?:inner|outer)HTML\b|insertAdjacentHTML/g }];

async function sourceGuard() {
  const problems = [];
  const walk = async (dir) => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(p);
      else if (/\.(?:ts|tsx)$/.test(ent.name) && !ent.name.includes(".selftest.")) {
        const text = await readFile(p, "utf8");
        for (const { name, re } of SOURCE_FORBIDDEN) for (const _m of text.matchAll(re)) problems.push(`${path.relative(ROOT, p)}: ${name}`);
      }
    }
  };
  await walk(path.join(ROOT, "src"));
  return problems;
}

/** The API permissions, exactly; anything optional or web-exposed fails the build. */
const PERMISSIONS = ["activeTab", "alarms", "contextMenus", "scripting", "storage"];

/**
 * Extra hosts ONLY the end-to-end build may reach, so the paste function can be exercised on a local
 * test page and on the Lexical editor's public playground (the editor WhatsApp Web is built on)
 * without a real right-click, which an automated browser cannot make. Never in a store build.
 */
const E2E_EXTRA_HOSTS = ["http://127.0.0.1/*", "https://playground.lexical.dev/*"];

const entries = (target) => ({
  background: {
    // The end-to-end build exposes the context-menu handler to the test (src/background/e2e.ts).
    entryPoints: [path.join(ROOT, E2E_TTL ? "src/background/e2e.ts" : "src/background/index.ts")],
    outfile: path.join(outDir(target), "background.js"),
  },
  popup: {
    entryPoints: [path.join(ROOT, "src/popup/main.tsx")],
    outfile: path.join(outDir(target), "popup.js"),
  },
});

const common = {
  bundle: true,
  splitting: false,
  format: "iife",
  platform: "browser",
  target: ["chrome120", "firefox128"],
  minify: false,
  keepNames: false,
  sourcemap: false,
  legalComments: "eof",
  charset: "ascii",
  jsx: "automatic",
  jsxImportSource: "preact",
  inject: [path.join(ROOT, "src/shims/buffer.ts")],
  define,
  logLevel: "warning",
};

async function writeManifest(target) {
  const tpl = JSON.parse(await readFile(path.join(ROOT, `manifest.${target}.json`), "utf8"));
  tpl.version = VERSION;
  const hosts = [...(tpl.host_permissions ?? [])].sort();
  if (E2E_TTL) tpl.host_permissions = [...tpl.host_permissions, ...E2E_EXTRA_HOSTS];
  if (JSON.stringify(hosts) !== JSON.stringify([...HOSTS].sort())) {
    throw new Error(`manifest.${target}.json host_permissions must be exactly: ${HOSTS.join(", ")}`);
  }
  if (JSON.stringify(tpl).includes("<all_urls>")) throw new Error(`manifest.${target}.json must not request <all_urls>`);
  if (tpl.content_security_policy?.extension_pages !== CSP) throw new Error(`manifest.${target}.json CSP must be: ${CSP}`);
  if (tpl.content_scripts || tpl.externally_connectable) {
    throw new Error(`manifest.${target}.json must not declare content_scripts or externally_connectable`);
  }
  if (JSON.stringify([...(tpl.permissions ?? [])].sort()) !== JSON.stringify(PERMISSIONS)) {
    throw new Error(`manifest.${target}.json permissions must be exactly: ${PERMISSIONS.join(", ")}`);
  }
  for (const key of ["optional_permissions", "optional_host_permissions", "web_accessible_resources"]) {
    if (key in tpl) throw new Error(`manifest.${target}.json must not declare ${key}`);
  }
  await writeFile(path.join(outDir(target), "manifest.json"), `${JSON.stringify(tpl, null, 2)}\n`);
}

async function copyStatic(target) {
  const out = outDir(target);
  await cp(path.join(ROOT, "static"), out, { recursive: true });
  const css = await Promise.all(["styles/tokens.css", "styles/popup.css"].map((f) => readFile(path.join(ROOT, f), "utf8")));
  await writeFile(path.join(out, "popup.css"), css.join("\n"));
}

async function scan(target) {
  const dir = outDir(target);
  const problems = [];
  const urls = new Map();
  for (const file of ["background.js", "popup.js"]) {
    const text = await readFile(path.join(dir, file), "utf8");
    for (const { name, re } of FORBIDDEN) {
      for (const m of text.matchAll(re)) {
        const around = text.slice(Math.max(0, m.index - 80), m.index + 80);
        const allowed = ALLOWED_OCCURRENCES.some((a) => a.file === file && a.name === name && around.includes(a.contains));
        if (!allowed) problems.push(`${target}/${file}: ${name} at ${m.index}: ...${around.replace(/\s+/g, " ")}...`);
      }
    }
    for (const m of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g)) {
      urls.set(m[0], (urls.get(m[0]) ?? 0) + 1);
    }
    const size = (await stat(path.join(dir, file))).size;
    console.log(`  ${target}/${file}: ${(size / 1024).toFixed(0)} KiB`);
  }
  return { problems, urls };
}

function zipDir(target) {
  const dir = path.join(DIST, target);
  const out = path.join(DIST, `lumenia-${target}-${VERSION}.zip`);
  execFileSync("rm", ["-f", out]);
  // -X: no extra file attributes, -r: recursive, -q: quiet. Sorted input keeps the entry order stable.
  const files = execFileSync("find", [".", "-type", "f"], { cwd: dir, encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .sort();
  execFileSync("zip", ["-X", "-q", out, ...files], { cwd: dir });
  return out;
}

async function sourcesZip() {
  const out = path.join(DIST, `lumenia-extension-sources-${VERSION}.zip`);
  execFileSync("rm", ["-f", out]);
  const rel = (p) => path.relative(REPO, p);
  const extFiles = execFileSync("find", [".", "-type", "f", "-not", "-path", "./node_modules/*", "-not", "-path", "./dist/*", "-not", "-name", ".env*"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    .map((f) => rel(path.join(ROOT, f)));
  const webLib = (await readdir(path.join(REPO, "apps/web/lib")))
    .filter((f) => f.endsWith(".ts") && !f.includes(".selftest.") && !f.includes(".livetest.") && !f.includes(".tool."))
    .map((f) => `apps/web/lib/${f}`);
  // Every workspace manifest the lockfile names as an importer: without them a frozen install of
  // the sources fails before the build starts.
  const rootFiles = [
    "package.json",
    ".npmrc",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/web/package.json",
    // esbuild reads the nearest tsconfig.json for each file it compiles; apps/web's "strict" decides
    // whether the reused lib modules get a "use strict" directive, so it is part of the build input.
    "apps/web/tsconfig.json",
    "apps/sponsor/package.json",
    "packages/shared/package.json",
    "LICENSE",
  ].filter((f) => existsSync(path.join(REPO, f)));
  execFileSync("zip", ["-X", "-q", out, ...[...extFiles, ...webLib, ...rootFiles].sort()], { cwd: REPO });
  return out;
}

async function buildTarget(target) {
  const out = outDir(target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const e = entries(target);
  await Promise.all([build({ ...common, ...e.background }), build({ ...common, ...e.popup })]);
  await copyStatic(target);
  await writeManifest(target);
}

async function once() {
  await mkdir(DIST, { recursive: true });
  const targets = E2E_TTL ? ["chrome"] : ["chrome", "firefox"];
  for (const target of targets) await buildTarget(target);
  console.log(`Lumenia extension ${VERSION}${E2E_TTL ? ` (END-TO-END BUILD: links expire after ${E2E_TTL} s; not for any store)` : ""}`);
  let failed = false;
  const srcProblems = await sourceGuard();
  if (srcProblems.length) {
    failed = true;
    console.error(`\nFORBIDDEN in src/:\n  ${srcProblems.join("\n  ")}`);
  }
  const allUrls = new Map();
  for (const target of targets) {
    const { problems, urls } = await scan(target);
    for (const [u, n] of urls) allUrls.set(u, (allUrls.get(u) ?? 0) + n);
    if (problems.length) {
      failed = true;
      console.error(`\nFORBIDDEN in ${target}:\n  ${problems.join("\n  ")}`);
    }
  }
  console.log("\nURLs found in the bundles (remote-code scan; data endpoints and documentation links are expected):");
  for (const [u, n] of [...allUrls].sort()) console.log(`  ${u}  x${n}`);
  if (failed) {
    console.error("\nBUILD FAILED: forbidden constructs in the output (see above).");
    process.exit(1);
  }
  if (E2E_TTL) return; // an end-to-end build is never packaged
  for (const target of targets) console.log(`zip: ${path.relative(ROOT, zipDir(target))}`);
  if (args.has("--sources")) console.log(`sources: ${path.relative(ROOT, await sourcesZip())}`);
}

if (args.has("--watch")) {
  for (const target of ["chrome", "firefox"]) {
    await mkdir(outDir(target), { recursive: true });
    const e = entries(target);
    const plugins = [
      {
        name: "static",
        setup(b) {
          b.onEnd(async () => {
            await copyStatic(target);
            await writeManifest(target);
          });
        },
      },
    ];
    for (const entry of [e.background, e.popup]) {
      const ctx = await context({ ...common, ...entry, plugins });
      await ctx.watch();
    }
  }
  console.log("watching src/ (dist/chrome, dist/firefox)");
} else {
  await once();
}
