# Keeping the worker alive on a Mac with launchd

The worker is restart-safe (`--once` polls, acts, exits; state lives in `~/.lumenia-near`). To run it every minute without a daemon manager:

1. Build once from the repository root: `pnpm --filter @lumenia/agent-market build` (type check, then the bundle `apps/agent-market/dist/worker.js`). Rebuild after every change to `apps/agent-market` or `packages/near`: the bundle inlines the library.
2. Create `~/.lumenia-near/run-agent-market.sh` (mode 0700). It loads `~/.lumenia-near/agent-market.env` (the token, 0600) and the NEAR env, then runs the bundle from the repository checkout. The shape, with `/Users/YOU` and the checkout path adjusted:

   ```bash
   #!/bin/bash
   # Modes: no argument = continuous poll loop, --once, --reclaim. Keys stay in ~/.near-credentials.
   set -u
   export PATH=/Users/YOU/.nvm/versions/node/v24.21.0/bin:/usr/local/bin:/usr/bin:/bin
   set -a; . /Users/YOU/.lumenia-near/agent-market.env; set +a
   export NEAR_NETWORK=testnet NEAR_RPC_URL=https://test.rpc.fastnear.com
   export LUMENIA_CONTRACT_ID=lumenia-near.testnet USDC_CONTRACT_ID=3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af
   export FUNDER_ACCOUNT_ID=lumenia-funder.testnet FUNDER_KEY_FILE=/Users/YOU/.near-credentials/testnet/lumenia-funder.testnet.json
   export WEB_ORIGIN=https://getlumenia.com LUMENIA_DATA_DIR=/Users/YOU/.lumenia-near/mcp-data
   export STATE_FILE=/Users/YOU/.lumenia-near/agent-market-state.json
   cd /Users/YOU/lumenia   # the repository checkout
   exec node apps/agent-market/dist/worker.js "$@"
   ```

3. Copy `com.lumenia.near-agent-market.plist` to `~/Library/LaunchAgents/`, replace `/Users/YOU` with your home directory.
4. Load it: `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.lumenia.near-agent-market.plist`
5. Check: `launchctl print gui/$(id -u)/com.lumenia.near-agent-market | grep -E "state|last exit"` and `tail ~/.lumenia-near/logs/agent-market.log`
6. Stop: `launchctl bootout gui/$(id -u)/com.lumenia.near-agent-market`

A second copy with `--reclaim` and `StartInterval` 3600 runs the hourly reclaim pass. The maintainer installs these by hand; nothing in this repository installs anything.
