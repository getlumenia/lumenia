/**
 * `/.well-known/stellar.toml` — SEP-0001, the file that makes `meric*getlumenia.com` resolvable
 * from any Stellar wallet (docs/IDENTITY_AND_ACCOUNTS.md §3.4).
 *
 * A wallet asked to pay `name*getlumenia.com` fetches this file over HTTPS, reads
 * FEDERATION_SERVER, and asks that server for the account. Without it a name is a Lumenia-only
 * nickname; with it, it is an address the rest of the ecosystem can use.
 *
 * ONE FILE, ONE NETWORK. SEP-1 has a single NETWORK_PASSPHRASE, so the file describes whichever
 * network this deployment's federation actually serves: the mainnet sponsor when one is
 * configured, the testnet sponsor otherwise. Advertising a mainnet passphrase next to a testnet
 * federation server would send real money at a lookup that cannot answer for it.
 *
 * Served through a rewrite (next.config.ts) because a `.well-known` directory does not survive as
 * an app-router segment. CORS is wide open by SEP-1's requirement — this file is meant to be read
 * by other people's wallets from other people's origins.
 */
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";
const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

export async function GET(): Promise<Response> {
  const mainnetSponsor = process.env.NEXT_PUBLIC_SPONSOR_URL_MAINNET;
  const testnetSponsor =
    process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
  const sponsor = (mainnetSponsor || testnetSponsor).replace(/\/$/, "");
  const passphrase = mainnetSponsor ? MAINNET_PASSPHRASE : TESTNET_PASSPHRASE;
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "https://getlumenia.com").replace(/\/$/, "");

  const toml = [
    `VERSION="2.0.0"`,
    `NETWORK_PASSPHRASE="${passphrase}"`,
    `FEDERATION_SERVER="${sponsor}/federation"`,
    ``,
    `[DOCUMENTATION]`,
    `ORG_NAME="Lumenia"`,
    `ORG_URL="${site}"`,
    `ORG_DESCRIPTION="Send and request dollars by link. The recipient claims without a wallet, without a seed phrase, and pays no gas."`,
    ``,
  ].join("\n");

  return new Response(toml, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "access-control-allow-origin": "*",
      // A name's account can change (a release, a re-claim), so this must not be cached for long.
      "cache-control": "public, max-age=300",
    },
  });
}
