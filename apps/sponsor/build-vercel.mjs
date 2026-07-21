/**
 * Build the sponsor as a Vercel Build Output API bundle (.vercel/output).
 *
 * WHY the Build Output API (and not vercel.json `functions` + a build command that
 * emits api/): Vercel's server-side build validates the `functions` glob BEFORE it
 * runs the build command, but the api/ dir is GENERATED here (empty at validation),
 * so the git-integration deploy errored with "unmatched function pattern" and never
 * ran the build. Removing that glob made the build pass but then Vercel served the
 * project static-only and never deployed the functions. Emitting .vercel/output
 * directly removes all of that ambiguity: Vercel deploys exactly what we produce
 * (functions + routing), so the sponsor deploys on a plain git push — no CLI and no
 * dependence on a dashboard build-command that a Git reconnect can silently reset.
 *
 * esbuild bundles each src/vercel/*.ts into a self-contained CJS function, which
 * resolves the @stellar/stellar-sdk ESM to @stellar/js-xdr `config` CJS interop at
 * build time (Vercel's plain Node ESM loader cannot).
 */
import { build } from "esbuild";
import { rmSync, mkdirSync, writeFileSync } from "node:fs";

const FUNCTIONS = [
  "health",
  "create-account",
  "feebump",
  "send-link",
  "sweep",
  "v2-claim",
  "v2-deposit",
  "faucet",
  "demo-link",
  "waitlist",
  "feedback",
  "events",
  "recovery",
  "recovery-otp",
  "recovery-fetch",
];

const OUT = ".vercel/output";
rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/static`, { recursive: true });

for (const name of FUNCTIONS) {
  const dir = `${OUT}/functions/${name}.func`;
  mkdirSync(dir, { recursive: true });
  await build({
    entryPoints: [`src/vercel/${name}.ts`],
    outfile: `${dir}/index.js`,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "warning",
  });
  // index.js is CJS; the repo root is type:module, so mark each function dir as
  // CommonJS explicitly (nearest package.json wins).
  writeFileSync(`${dir}/package.json`, JSON.stringify({ type: "commonjs" }) + "\n");
  // Vercel Node launcher with request/response helpers (req.body, res.json, …).
  writeFileSync(
    `${dir}/.vc-config.json`,
    JSON.stringify(
      {
        runtime: "nodejs22.x",
        handler: "index.js",
        maxDuration: 30,
        launcherType: "Nodejs",
        shouldAddHelpers: true,
      },
      null,
      2,
    ) + "\n",
  );
}

// A function at functions/<name>.func is served at /<name>, so /health, /feebump,
// /create-account, … resolve to the functions directly — no rewrites needed.
// version 3 is the required Build Output API version.
writeFileSync(`${OUT}/config.json`, JSON.stringify({ version: 3 }, null, 2) + "\n");

// Minimal static root, served at /.
writeFileSync(
  `${OUT}/static/index.html`,
  '<!doctype html><meta charset="utf-8"><title>Lumenia sponsor</title>' +
    '<p>Lumenia sponsor service (testnet). Health: <a href="/health">/health</a>.</p>\n',
);

console.log(`✔ built Build Output API (.vercel/output): ${FUNCTIONS.length} functions + static root`);
