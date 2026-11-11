// pm2 process file: `pm2 start ops/ecosystem.config.cjs` from apps/agent-market/ after
// `pnpm --filter @lumenia/agent-market build` (the bundle is dist/worker.js).
// The worker reads .env (gitignored) through Node's --env-file-if-exists flag, so no secret is in this file.
const path = require("node:path");

module.exports = {
  apps: [
    {
      name: "lumenia-agent-market",
      cwd: path.join(__dirname, ".."),
      script: "dist/worker.js",
      interpreter: "node",
      node_args: "--env-file-if-exists=.env",
      autorestart: true,
      restart_delay: 10_000,
      max_restarts: 100,
      kill_timeout: 45_000,
      time: true,
      env: { NODE_ENV: "production" },
    },
  ],
};
