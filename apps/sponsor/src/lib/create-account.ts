/**
 * /create-account — sponsored 0-XLM onboarding.
 *
 * Builds the sponsored-reserve sandwich that gives a brand-new recipient an
 * account + a USDC trustline while they hold 0 XLM (the sponsor covers both
 * reserves and the fee):
 *
 *   beginSponsoringFutureReserves(sponsoredId=recipient)   [source: sponsor]
 *   createAccount(destination=recipient, startingBalance=0) [source: sponsor]
 *   changeTrust(USDC)                                       [source: recipient]
 *   endSponsoringFutureReserves()                           [source: recipient]
 *
 * TX SOURCE — two paths (C1 fix):
 *  • CHANNEL path (when CHANNEL_SECRETS is configured): tx.source = a leased CHANNEL
 *    account, so its independent sequence number serves this onboarding. Different
 *    concurrent claims lease different channels → no tx_bad_seq collision (the sponsor's
 *    single sequence no longer serializes everyone). The channel pays the tiny classic
 *    fee (it is sponsor-funded, so value never leaves the sponsor); the sponsor still
 *    sources + signs begin/createAccount (the reserves) — it never gives up authority.
 *    The client submits the tx, so the lease is HELD (not released) — its TTL guards
 *    reuse until the handout is submitted or dead (see lib/channels.ts).
 *  • SPONSOR path (fallback, and the original behavior): tx.source = sponsor. Used when
 *    no channel is configured/free — never worse than before.
 *
 * The recipient account does not exist yet, so it cannot provide a sequence number; the
 * sponsor pays the fee directly on the sponsor path (no fee-bump needed here — fee-bump
 * is the /feebump claim path, where tx.source = recipient). The sponsor signs its half;
 * the recipient co-signs `changeTrust`+`end` on-device, then submits.
 *
 * The sponsor BUILDS this tx itself from a single untrusted input (the recipient public
 * key), so there is nothing client-supplied to anti-drain-validate here; the allowlist
 * validator guards the /feebump path, where the client builds the tx.
 */
import {
  BASE_FEE,
  Operation,
  StrKey,
  TransactionBuilder,
  type Transaction,
  type Horizon,
} from "@stellar/stellar-sdk";
import type { SponsorConfig } from "./config";
import type { SponsorSigner } from "./signer";
import { CHANNEL_TX_TIMEOUT_SECONDS, type ChannelManager } from "./channels";

/** The source-account interface TransactionBuilder accepts (the concrete Account class OR
 * Horizon's AccountResponse from loadAccount both satisfy it). */
type TxSourceAccount = ConstructorParameters<typeof TransactionBuilder>[0];

export interface CreateAccountInput {
  recipientPublicKey: string;
}

export interface CreateAccountResult {
  /** Sponsor-signed sandwich, base64 XDR. The recipient co-signs, then it is submitted. */
  xdr: string;
  sponsorPublicKey: string;
  network: SponsorConfig["network"];
  /** The USDC asset the trustline was opened to (so the client can verify / build the claim). */
  usdcCode: string;
  usdcIssuer: string;
  /** Ops the recipient must still sign (changeTrust + endSponsoring). */
  recipientMustSign: true;
  /** Which tx-source path built this sandwich (observability; the client ignores it). */
  via?: "channel" | "sponsor";
  /** "onboarding" = the 4-op sandwich; "trustline" = 3 ops, for an account already on-ledger. */
  mode?: "trustline" | "onboarding";
}

function assertValidRecipient(pub: string): void {
  if (!StrKey.isValidEd25519PublicKey(pub)) {
    throw new Error(`invalid recipientPublicKey: ${pub}`);
  }
}

/**
 * Assemble the sandwich on a given SOURCE account (sponsor OR channel). The ops are
 * identical either way — only the tx source (and thus the sequence + fee account) and
 * the timebound differ. When the source is a channel, the CALLER must also sign with the
 * channel keypair (it is the tx source); the sponsor always signs begin+createAccount.
 */
function assembleSandwich(
  sourceAccount: TxSourceAccount,
  config: SponsorConfig,
  sponsorPublicKey: string,
  recipientPublicKey: string,
  timeoutSeconds: number,
  /**
   * Omit the `createAccount` op for an account that ALREADY EXISTS on this ledger.
   *
   * Without this the only way to get a USDC trustline was a transaction containing
   * `createAccount`, which Horizon rejects with `op_already_exists` the moment the account is
   * there — so an account that existed WITHOUT a trustline could never be given one. That is not
   * a corner case: it is every account funded from outside (somebody sends it 1 XLM to "activate"
   * it) and every account that lost its trustline. The activation button built a transaction that
   * could only fail, and reported it as "400 Bad Request".
   *
   * The 3-op shape is strictly LESS than the 4-op one — the sponsor still sources `begin` (it pays
   * the trustline's reserve) and the account still signs its own `changeTrust`.
   */
  trustlineOnly = false,
): Transaction {
  const builder = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  }).addOperation(
    Operation.beginSponsoringFutureReserves({ sponsoredId: recipientPublicKey, source: sponsorPublicKey }),
  );
  if (!trustlineOnly) {
    builder.addOperation(
      Operation.createAccount({ destination: recipientPublicKey, startingBalance: "0", source: sponsorPublicKey }),
    );
  }
  return builder
    .addOperation(Operation.changeTrust({ asset: config.usdc, source: recipientPublicKey }))
    .addOperation(Operation.endSponsoringFutureReserves({ source: recipientPublicKey }))
    .setTimeout(timeoutSeconds)
    .build();
}

/**
 * Does this account already exist on-ledger? A 404 is the ordinary answer for the claim path (a
 * brand-new key), so it is not an error; anything else that fails is treated as "does not exist"
 * only when Horizon actually says 404 — a network blip must not silently drop the createAccount op
 * and produce a transaction that fails for a different reason.
 */
export async function accountExists(server: Horizon.Server, pubkey: string): Promise<boolean> {
  try {
    await server.loadAccount(pubkey);
    return true;
  } catch (e) {
    const status = (e as { response?: { status?: number } })?.response?.status;
    if (status === 404) return false;
    throw new Error(`could not check whether ${pubkey.slice(0, 6)}… exists: ${(e as Error).message}`);
  }
}

/** Sponsor-sourced sandwich (the fallback / original path). tx.source = sponsor. */
export async function buildCreateAccountSandwich(
  server: Horizon.Server,
  config: SponsorConfig,
  sponsorPublicKey: string,
  recipientPublicKey: string,
  /** See assembleSandwich: true when the account is already on-ledger. */
  trustlineOnly = false,
): Promise<Transaction> {
  assertValidRecipient(recipientPublicKey);
  if (recipientPublicKey === sponsorPublicKey) {
    throw new Error("recipient must differ from the sponsor");
  }
  const sponsorAccount = await server.loadAccount(sponsorPublicKey);
  return assembleSandwich(sponsorAccount, config, sponsorPublicKey, recipientPublicKey, 180, trustlineOnly);
}

/**
 * Platform-agnostic handler: (config, signer, input[, channels]) → sponsor-signed
 * sandwich XDR. Reused by the local node:http server, the Vercel adapter, and the Worker.
 *
 * When `channels` is enabled AND a lease is available, the sandwich is CHANNEL-sourced
 * (C1 fix); otherwise it falls back to the sponsor-sourced sandwich. The fallback also
 * covers any channel-path error, so an onboarding is never blocked by the pool.
 */
export async function createAccountHandler(
  server: Horizon.Server,
  config: SponsorConfig,
  signer: SponsorSigner,
  input: CreateAccountInput,
  channels?: ChannelManager,
): Promise<CreateAccountResult> {
  assertValidRecipient(input.recipientPublicKey);
  if (input.recipientPublicKey === signer.publicKey()) {
    throw new Error("recipient must differ from the sponsor");
  }

  /* Decided ONCE, before either path builds anything: an existing account must not be handed a
     `createAccount` op (op_already_exists → the client sees a bare 400), and a missing one must
     still get created. Both paths below assemble from this same answer, so they cannot disagree. */
  const exists = await accountExists(server, input.recipientPublicKey);

  const base = {
    sponsorPublicKey: signer.publicKey(),
    network: config.network,
    usdcCode: config.usdc.getCode(),
    // USDC is always a credit asset (constructed with an issuer), never native.
    usdcIssuer: config.usdc.getIssuer()!,
    recipientMustSign: true as const,
    /** Which shape this is: the 4-op onboarding, or the 3-op trustline for an account that exists. */
    mode: (exists ? "trustline" : "onboarding") as "trustline" | "onboarding",
  };

  // CHANNEL path — an independent sequence per concurrent onboarding (C1 fix).
  const lease = channels?.enabled ? await channels.lease() : null;
  if (lease) {
    try {
      const channelAccount = await server.loadAccount(lease.publicKey);
      const tx = assembleSandwich(
        channelAccount,
        config,
        signer.publicKey(),
        input.recipientPublicKey,
        CHANNEL_TX_TIMEOUT_SECONDS,
        exists,
      );
      tx.sign(lease.keypair); // channel = tx source (lends its sequence, pays the fee)
      await signer.sign(tx); // sponsor = begin + createAccount (the reserves)
      // Do NOT release the lease: the CLIENT submits this tx later. The lease TTL guards
      // the channel from reuse until the handout is submitted or dead (tx_too_late).
      return { xdr: tx.toXDR(), via: "channel", ...base };
    } catch (e) {
      // A channel-path failure must never strand the onboarding — release + fall back.
      await lease.release();
      console.warn(`[create-account] channel path failed, falling back to sponsor: ${(e as Error).message}`);
    }
  }

  // SPONSOR path — the original behavior (tx.source = sponsor). Serializes on the
  // sponsor's single sequence; used only when no channel is configured/free.
  const tx = await buildCreateAccountSandwich(server, config, signer.publicKey(), input.recipientPublicKey, exists);
  await signer.sign(tx);
  return { xdr: tx.toXDR(), via: "sponsor", ...base };
}
