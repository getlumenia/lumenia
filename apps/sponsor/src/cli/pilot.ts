#!/usr/bin/env node
/**
 * pilot — owner CLI for the user-funded mainnet pilot allowlist.
 *
 * Adds / removes / checks / lists wallets in the SAME Upstash store the Worker's pilot guard reads
 * (lib/pilot.ts). Namespaced by STELLAR_NETWORK, so run it with the SAME network + KV env the
 * mainnet Worker uses, or you'll write to the testnet namespace by mistake (the output names
 * the network so you can catch that).
 *
 *   RUN:  read -r KV_REST_API_URL && read -rs KV_REST_API_TOKEN && export KV_REST_API_URL KV_REST_API_TOKEN
 *         STELLAR_NETWORK=mainnet pnpm --filter @lumenia/sponsor pilot approve G...
 *         (the token is read hidden, never typed on a command line; unset KV_REST_API_TOKEN afterwards)
 *         ...pilot approve G... G... G...        several at once
 *         ...pilot approve --file wallets.txt    one G... per line, # comments allowed
 *         ...pilot list [pending|approved|rejected|revoked|none|all]   (default: pending)
 *                                                counts per state first, then the wallets, with src
 *         ...pilot waitlist                      the people who asked with no account yet (emails)
 *         ...pilot notify G...                   re-send the "you're in" mail (needs RESEND_API_KEY,
 *                                                RESEND_FROM and MAX_DROP_USDC = the Worker's cap)
 *         ...pilot reject G...    |    ...pilot revoke G...    |    ...pilot status G...
 *         ...pilot reset G...                    put the wallet's used slots back to 0 (approval never does)
 *   NEEDS: KV_REST_API_URL / KV_REST_API_TOKEN (Upstash). No signing keys — this only writes
 *          an allowlist flag, it never touches money. The approval mail goes out only when
 *          RESEND_API_KEY (+ RESEND_FROM) are ALSO in this shell's env; otherwise the wallet is
 *          approved silently and the output says so, so you can `notify` it later.
 */
import { readFileSync } from "node:fs";
import { StrKey } from "@stellar/stellar-sdk";
import {
  approvePilot,
  rejectPilot,
  revokePilot,
  resetPilotBudget,
  pilotStatus,
  getPilotEmail,
  getPilotSrc,
  listPilot,
} from "../lib/pilot.js";
import { notifyPilotApproved, notifyPilotRejected, pilotCaps } from "../lib/pilot-request.js";
import { listContacts } from "../lib/waitlist.js";
import { pilotListLines, pilotStatusLines, waitlistLines, type PilotListFilter } from "../lib/pilot-report.js";

const COMMANDS = ["approve", "reject", "revoke", "status", "list", "waitlist", "notify", "reset"] as const;
type Command = (typeof COMMANDS)[number];
const STATES = ["pending", "approved", "rejected", "revoked", "none", "all"] as const;

function usage(): never {
  console.error(
    [
      "usage: pilot approve <G...> [<G...> ...] | approve --file <path>",
      "       pilot reject|revoke|status|notify|reset <G...>",
      "       pilot list [pending|approved|rejected|revoked|none|all]",
      "       pilot waitlist",
    ].join("\n"),
  );
  process.exit(1);
}

/** Positional G... keys, or the non-empty, non-comment lines of --file. Refuses anything malformed. */
function walletsFrom(args: string[]): string[] {
  let keys: string[];
  const fileAt = args.indexOf("--file");
  if (fileAt >= 0) {
    const path = args[fileAt + 1];
    if (!path) usage();
    keys = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, "").trim())
      .filter((l) => l.length > 0);
  } else {
    keys = args;
  }
  if (keys.length === 0) usage();
  for (const k of keys) {
    if (!StrKey.isValidEd25519PublicKey(k)) {
      console.error(`not a valid Stellar public key: ${k}`);
      process.exit(1);
    }
  }
  return [...new Set(keys)];
}

/**
 * The welcome mail quotes the pilot's caps from the env (lib/pilot-request.ts `pilotCaps`: MAX_DROP_USDC,
 * MAX_DAY_USDC_PER_SENDER and MAX_DAY_USDC, through lib/caps.ts). The Worker has them from
 * wrangler.toml; an owner shell usually does not, and the testnet defaults (100 a transfer) would
 * promise caps the mainnet Worker does not run (5). So no approval mail leaves this CLI unless the
 * per-transfer cap is set explicitly in this shell (with STELLAR_NETWORK=mainnet the two day caps
 * default to the pilot's 25 and 50); the output prints the caps the mail quoted.
 */
function mailCap(): string | null {
  const v = process.env.MAX_DROP_USDC?.trim();
  return v ? v : null;
}

async function approveOne(pubkey: string, net: string): Promise<void> {
  await approvePilot(pubkey);
  const s = await pilotStatus(pubkey);
  console.log(`approved for the ${net} pilot: ${pubkey}`);
  // Approval never refills spent slots (lib/pilot.ts, approvePilot), so say how many are left.
  console.log(`  budget: ${s.limit} transactions, ${s.used} already used`);
  const email = await getPilotEmail(pubkey);
  if (!email) {
    console.log("  No email on file, so nobody was told. Tell them yourself.");
    return;
  }
  if (!process.env.RESEND_API_KEY) {
    console.log(`  (email on file, but RESEND_API_KEY is not in this shell — run \`pilot notify ${pubkey}\` later)`);
    return;
  }
  if (!mailCap()) {
    console.log(`  (mail NOT sent: MAX_DROP_USDC is not set here, so it would quote the default cap; set the Worker's value and run \`pilot notify ${pubkey}\`)`);
    return;
  }
  if (await notifyPilotApproved(pubkey, email)) {
    console.log(`  emailed:  ${email} (quoting: ${pilotCaps().full})`);
  } else {
    console.log(`  (mail NOT sent: Resend refused it, see the [pilot:approved] line above; run \`pilot notify ${pubkey}\` once fixed)`);
  }
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const net = process.env.STELLAR_NETWORK ?? "testnet";

  if (!cmd || !(COMMANDS as readonly string[]).includes(cmd)) usage();

  switch (cmd as Command) {
    case "list": {
      const want = (rest[0] ?? "pending") as (typeof STATES)[number];
      if (!(STATES as readonly string[]).includes(want)) usage();
      for (const line of pilotListLines(await listPilot("all"), want as PilotListFilter, net)) console.log(line);
      break;
    }
    case "waitlist": {
      for (const line of waitlistLines(await listContacts("pilot"))) console.log(line);
      break;
    }
    case "approve": {
      const wallets = walletsFrom(rest);
      let failed = 0;
      for (const pk of wallets) {
        try {
          await approveOne(pk, net);
        } catch (e) {
          failed++;
          console.error(`FAILED ${pk}: ${(e as Error).message}`);
        }
      }
      console.log(`${wallets.length - failed}/${wallets.length} approved on ${net}`);
      if (failed > 0) process.exit(1);
      break;
    }
    case "notify": {
      const [pubkey] = walletsFrom(rest.slice(0, 1));
      const s = await pilotStatus(pubkey!);
      if (!s.approved) {
        console.error(`${pubkey} is not approved on ${net}; nothing to announce`);
        process.exit(1);
      }
      const email = await getPilotEmail(pubkey!);
      if (!email) {
        console.log(`no stored email for ${pubkey} (expired or never given): tell them by hand`);
        break;
      }
      if (!process.env.RESEND_API_KEY) {
        console.error("RESEND_API_KEY is not set in this shell; export it (and RESEND_FROM) and retry");
        process.exit(1);
      }
      const cap = mailCap();
      if (!cap) {
        console.error(
          "MAX_DROP_USDC is not set in this shell, so the mail would quote the code default (100) instead of " +
            "the Worker's cap; export the Worker's value (mainnet: 5, wrangler.toml [env.mainnet.vars]) and retry",
        );
        process.exit(1);
      }
      if (!(await notifyPilotApproved(pubkey!, email))) {
        console.error(
          `NOT sent: Resend refused the mail (see the [pilot:approved] line above). ` +
            "Check that RESEND_FROM is a verified sender and the key is right, then retry.",
        );
        process.exit(1);
      }
      console.log(`emailed the approval (quoting: ${pilotCaps().full}) to ${email} for ${pubkey}`);
      break;
    }
    case "reject": {
      const [pubkey] = walletsFrom(rest.slice(0, 1));
      // The same line the emailed Decline link takes: a second decline changes nothing and mails nobody.
      if ((await pilotStatus(pubkey!)).state === "rejected") {
        console.log(`already declined on the ${net} pilot: ${pubkey}. No second email sent.`);
        break;
      }
      await rejectPilot(pubkey!);
      console.log(`declined from the ${net} pilot: ${pubkey}`);
      const email = await getPilotEmail(pubkey!);
      if (email) {
        if (await notifyPilotRejected(pubkey!, email)) console.log(`  emailed:  ${email}`);
        else console.log(`  (mail NOT sent: see the [pilot:rejected] line above)`);
      } else {
        console.log("  No email on file, so nobody was told. Tell them yourself.");
      }
      break;
    }
    case "revoke": {
      const [pubkey] = walletsFrom(rest.slice(0, 1));
      await revokePilot(pubkey!);
      console.log(`revoked from the ${net} pilot: ${pubkey}`);
      break;
    }
    case "reset": {
      const [pubkey] = walletsFrom(rest.slice(0, 1));
      const was = await resetPilotBudget(pubkey!);
      console.log(`reset the ${net} pilot budget of ${pubkey}: ${was} used -> 0`);
      break;
    }
    case "status": {
      const [pubkey] = walletsFrom(rest.slice(0, 1));
      const s = await pilotStatus(pubkey!);
      for (const line of pilotStatusLines(net, pubkey!, s, await getPilotSrc(pubkey!))) console.log(line);
      break;
    }
  }
}

main().catch((e) => {
  console.error(`pilot CLI error: ${(e as Error).message}`);
  process.exit(1);
});
