"use client";

/**
 * The judge board's live half. What each tile reads, and why:
 *
 *  1. PEOPLE, per network: `GET {sponsor}/events/summary` on BOTH Workers (the store is shared and
 *     namespaced by network). Claimed, then who went on to send a link themselves (referral), with
 *     the team-funded ("seeded") cohort kept apart from people paying each other. Team accounts are
 *     excluded by the sponsor (EVENTS_EXCLUDE_AIDS). The mainnet counters only started receiving
 *     beacons on 19 Sept 2026 (the claim beacon used to route by the device's network flag, which a
 *     first-time recipient does not have), so the mainnet numbers are "since 19 Sept" by
 *     construction. Counts only: the counters never see an amount; every transfer is on the ledger.
 *     The board says that out loud under the real-money tiles, with the pre-measurement pilot's own
 *     figure AND its dollar value, so a zero there reads as a scope rather than as an absence.
 *  2. LIRA RAIL: the last deposit and cash-out completed ON THIS DEVICE (lib/rail-record.ts). The
 *     anchor lists a person's transfers only to that person's own session and we keep no server
 *     record of anyone's bank activity, so another device honestly shows "no run here yet".
 *  3. PARTNERS: Circle CCTP inbound with the two proven runs' hashes (19 Sept 2026, Base Sepolia to
 *     Stellar testnet through the CctpForwarder) plus the live `cctp_funded` count; Stellar Wallets
 *     Kit only when its flag is on in this build.
 *  4. SCAN: a fresh practice link minted by the testnet sponsor's demo pool (`POST /demo-link`,
 *     testnet-only in the Worker), marked seeded=1 so it is counted as team-funded. The same link
 *     is printed under the code as text, because a judge reading this on a laptop cannot scan their
 *     own screen; its middle is hidden, because the link is a bearer key and a board on a projector
 *     is a photograph waiting to happen.
 *
 * Polls every 30 s: the testnet Worker's summary shares the per-IP bucket (30/min) with claims from
 * the same venue network, so the board must never be the reason a guest's claim is rate limited.
 */
import { useCallback, useEffect, useState } from "react";
import QRCode from "react-qr-code";
import { explorerTxOn, mainnetConfig, testnetConfig, type NetworkConfig } from "../../../lib/network";
import { RAIL_LAST_DEPOSIT_KEY, RAIL_LAST_WITHDRAW_KEY, readRailRun, type RailRun } from "../../../lib/rail-record";
import { walletsKitEnabled } from "../../../lib/wallets-kit";

interface Summary {
  network: string;
  totals: Record<string, number>;
  funnel: { claimed: number; acted: number; both: number; referral: number; referralRate: number | null; repeat: number };
  seeded: { claimed: number; referral: number; acted: number };
  organic: { claimed: number; referral: number; acted: number };
  durations: Record<string, number>;
  excludedAccounts: number;
}

type Load = { state: "loading" } | { state: "ok"; data: Summary; at: number } | { state: "unavailable"; why: string };

const POLL_MS = 30_000;

/** The two proven CCTP inbound runs (docs: HACKATHON_BEFORE.md section 6). */
const CCTP_RUNS = [
  {
    label: "Fast finality",
    burn: "0xddf8f16a31f3893577460ec5041204db66b8f6f009bbafc1614b49e7be6208fc",
    mint: "617908c7864927191fcdddd202ba279bf8269f371ca06fd8e89bde5f0efe1261",
    note: "attestation in 11 s, 18 s from burn to mint, 1.9997400 USDC received",
  },
  {
    label: "Standard finality",
    burn: "0xf79328e104e030833a598dfb4954b252885d32b9f58c919cca89e09f2d05aa00",
    mint: "a5c4eae02c67b1ed6a8b6cfc9c2617cefa502e74f7414ff46c8208239412aa4d",
    note: "2.0000000 USDC received, no fee",
  },
];

async function readSummary(net: NetworkConfig): Promise<Load> {
  if (!net.sponsorUrl) return { state: "unavailable", why: "This network is not configured in this build." };
  try {
    const r = await fetch(`${net.sponsorUrl.replace(/\/$/, "")}/events/summary`, { cache: "no-store" });
    if (r.status === 429) return { state: "unavailable", why: "The counter is busy; the board retries in 30 s." };
    if (!r.ok) return { state: "unavailable", why: `The counter answered ${r.status}.` };
    return { state: "ok", data: (await r.json()) as Summary, at: Date.now() };
  } catch {
    return { state: "unavailable", why: "The counter could not be reached." };
  }
}

function under30(d: Record<string, number>): string | null {
  const total = Object.values(d).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const fast = (d["0-15"] ?? 0) + (d["15-30"] ?? 0);
  return `${Math.round((fast / total) * 100)}% of ${total}`;
}

/**
 * The claim link, printed for anyone who cannot scan it. Everything from the `?` onward is
 * replaced by an ellipsis: that is where the balance id sits, and the bearer key sits after it in
 * the fragment, and this board goes on a projector in front of a room holding phones. What is left
 * is enough to recognise the link; the href stays whole, so opening it still claims.
 */
function shortLink(url: string): string {
  if (url.length <= 54) return url;
  const query = url.indexOf("?");
  return `${query > 0 ? url.slice(0, query) : url.slice(0, 38)}...${url.slice(-8)}`;
}

function PeopleTiles({ load, real }: { load: Load; real: boolean }) {
  if (load.state === "loading") return <p className="stat-refreshing">Reading the counters…</p>;
  if (load.state === "unavailable") return <p className="stat-refreshing">{load.why} Nothing is shown rather than a guess.</p>;
  const s = load.data;
  const fast = under30(s.durations ?? {});
  return (
    <div className="stat-grid">
      <div className="stat-tile">
        <span className={`stat-num${real ? " stat-num-accent" : ""}`}>{s.funnel.claimed}</span>
        <span className="stat-label">People who claimed a link</span>
        <span className="stat-sub">
          {s.seeded.claimed} from team-funded links, {s.organic.claimed} from links other people sent
        </span>
      </div>
      <div className="stat-tile">
        <span className="stat-num">{s.funnel.referral}</span>
        <span className="stat-label">Then sent a link themselves</span>
        <span className="stat-sub">
          {s.seeded.referral} of them started from a team-funded link; {s.totals.send_link_created ?? 0} links created in all
        </span>
      </div>
      <div className="stat-tile">
        <span className="stat-num">{fast ?? "none yet"}</span>
        <span className="stat-label">Claims done within 30 s</span>
        <span className="stat-sub">opening the link to money in the account, timed on the phone</span>
      </div>
    </div>
  );
}

function RailRunView({ title, run, href }: { title: string; run: RailRun | null; href: string }) {
  return (
    <div className="ev-card">
      <h3>{title}</h3>
      {run ? (
        <>
          <div className="ev-row">
            <span>When</span>
            <b>{new Date(run.at).toLocaleTimeString()}</b>
          </div>
          {run.amountIn && (
            <div className="ev-row">
              <span>In</span>
              <b>{run.amountIn}</b>
            </div>
          )}
          {run.amountOut && (
            <div className="ev-row">
              <span>Out</span>
              <b>{run.amountOut} USDC</b>
            </div>
          )}
          <div className="ev-row">
            <span>Time</span>
            <b>{run.seconds} s</b>
          </div>
          {run.tx && (
            <a className="ev-hash" href={explorerTxOn(testnetConfig(), run.tx)} target="_blank" rel="noreferrer">
              {run.tx}
            </a>
          )}
          <span className="ev-muted">Rail: {run.rail} (sandbox anchor, test network), SEP-10 sign-in and SEP-6.</span>
        </>
      ) : (
        <>
          <span className="ev-muted">No run on this device yet. The rail only shows a person their own transfers, and we keep no copy of anyone&apos;s.</span>
          <a className="ev-btn" href={href}>
            Run one now
          </a>
        </>
      )}
    </div>
  );
}

export function EventBoard() {
  const main = mainnetConfig();
  const test = testnetConfig();
  const [real, setReal] = useState<Load>({ state: "loading" });
  const [practice, setPractice] = useState<Load>({ state: "loading" });
  const [dep, setDep] = useState<RailRun | null>(null);
  const [wd, setWd] = useState<RailRun | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState("");

  const refresh = useCallback(async () => {
    const [r, p] = await Promise.all([main ? readSummary(main) : Promise.resolve<Load>({ state: "unavailable", why: "Mainnet is not configured in this build." }), readSummary(test)]);
    setReal(r);
    setPractice(p);
    // The rail record is written per network by the rail screens; the rail is testnet-only.
    setDep(readRailRun(RAIL_LAST_DEPOSIT_KEY("testnet")));
    setWd(readRailRun(RAIL_LAST_WITHDRAW_KEY("testnet")));
  }, [main, test]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  async function mint() {
    setMinting(true);
    setMintError("");
    try {
      const res = await fetch(`${test.sponsorUrl.replace(/\/$/, "")}/demo-link`, { method: "POST" }).catch(() => null);
      if (!res) throw new Error("The practice sponsor could not be reached.");
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `It answered ${res.status}.`);
      const d = (await res.json()) as { balanceId: string; bearerSecret: string; amount: string; issuer: string; from: string };
      const q = `a=${encodeURIComponent(d.amount)}&s=${encodeURIComponent("Lumenia team")}&b=${d.balanceId}&i=${d.issuer}&seeded=1`;
      setLink(`${window.location.origin}/c/${d.balanceId.slice(-8)}?${q}#${d.bearerSecret}`);
    } catch (e) {
      setMintError(e instanceof Error ? e.message : "Could not make a link just now.");
    } finally {
      setMinting(false);
    }
  }

  const cctpCount = practice.state === "ok" ? (practice.data.totals.cctp_funded ?? 0) : null;
  const depCount = practice.state === "ok" ? (practice.data.totals.deposit_completed ?? 0) : null;
  const wdCount = practice.state === "ok" ? (practice.data.totals.cashout_bank_sent ?? 0) : null;

  return (
    <section className="stat-body" aria-label="Live event board: people, the lira rail and the partner runs">
      <div className="stat-inner">
        <div className="ev-head">
          <h2 className="stat-section-h">People, real money</h2>
          <span className="ev-badge ev-real">Mainnet, capped pilot</span>
        </div>
        <p className="stat-section-sub">
          Counted since 19 Sept 2026, when mainnet measurement went live. Team accounts are excluded.
          Counts only: our counters never see amounts, and every transfer is on the public record.
        </p>
        <PeopleTiles load={real} real />
        {/* These tiles can legitimately read zero, and a bare zero on a judge's screen reads as
            "nothing ever happened here". It is a scope, so the scope is stated, together with the
            figure the pilot did move AND what that figure is worth, which is the only honest way to
            quote a transfer count this small. The per-day cap is deliberately NOT quoted here: it
            is raised for the event and reverted the same night, and a board cannot follow that. */}
        <p className="stat-note">
          <strong>A zero here is a scope, not an absence.</strong> These counters started on 19 Sept
          2026, so a zero means nobody has claimed a real-money link since then. The hand-approved
          pilot that ran before them moved 109 transfers, about $4.4 in total, median $0.002 and
          largest $1.00, re-counted from the public record on 6 Sept 2026. No single transfer may
          exceed $5: the numbers are meant to be checkable, not impressive.
        </p>

        <div className="ev-head">
          <h2 className="stat-section-h">People, practice money</h2>
          <span className="ev-badge">Testnet</span>
        </div>
        <p className="stat-section-sub">The same product on the test network, where most guests try it first. Includes our own testing.</p>
        <PeopleTiles load={practice} real={false} />

        <div className="ev-head">
          <h2 className="stat-section-h">Lira rail: TRY to dollars and back</h2>
          <span className="ev-badge">Testnet, sandbox anchor</span>
        </div>
        <p className="stat-section-sub">
          SEP-1 discovery, SEP-10 sign-in and SEP-6 deposit and withdraw against the organisers&apos; sandbox
          anchor. The anchor always meets a ready account: our sponsor opened it and its dollar
          trustline for someone holding zero XLM.
          {depCount !== null && wdCount !== null ? ` Counted so far: ${depCount} lira-in completed, ${wdCount} bank cash-outs sent.` : ""}
        </p>
        <div className="ev-two">
          <RailRunView title="Last lira in (deposit)" run={dep} href="/add-money/bank" />
          <RailRunView title="Last lira out (bank cash-out)" run={wd} href="/send-out/bank" />
        </div>

        <div className="ev-head">
          <h2 className="stat-section-h">Partners</h2>
        </div>
        <div className="ev-two">
          <div className="ev-card">
            <h3>Circle CCTP: USDC from Base arrives in a Lumenia account</h3>
            <span className="ev-muted">
              Burn on Base Sepolia with a hook, Circle attests, the Stellar CctpForwarder mints to the
              account. Proven twice on 19 Sept 2026 (testnet).
              {cctpCount !== null ? ` Funded in the app so far: ${cctpCount}.` : ""}
            </span>
            {CCTP_RUNS.map((r) => (
              <div key={r.burn} className="ev-card" style={{ padding: 12 }}>
                <div className="ev-row">
                  <span>{r.label}</span>
                </div>
                <a className="ev-hash" href={`https://sepolia.basescan.org/tx/${r.burn}`} target="_blank" rel="noreferrer">
                  burn {r.burn}
                </a>
                <a className="ev-hash" href={explorerTxOn(test, r.mint)} target="_blank" rel="noreferrer">
                  mint {r.mint}
                </a>
                <span className="ev-muted">{r.note}</span>
              </div>
            ))}
          </div>
          <div className="ev-card">
            <h3>Scan: get practice dollars</h3>
            <span className="ev-muted">
              A fresh link from our practice sponsor. No app, no wallet, no sign-up; the first phone to
              open it gets the money. Test network.
            </span>
            {link ? (
              <>
                <div
                  className="ev-qr"
                  role="img"
                  aria-label="QR code holding a practice-dollar claim link. The same link is written out just below as a link you can open directly."
                >
                  <QRCode value={link} size={200} bgColor="#FFFFFF" fgColor="#000000" level="M" />
                </div>
                <a className="ev-hash" href={link} target="_blank" rel="noreferrer">
                  {shortLink(link)}
                </a>
                <span className="ev-muted">
                  Open it on this machine, or scan it with a phone. The middle is hidden on purpose:
                  this link is the money, so whoever holds it whole can claim it.
                </span>
              </>
            ) : null}
            <button className="ev-btn" onClick={() => void mint()} disabled={minting}>
              {minting ? "Making a link…" : link ? "Make another link" : "Make a link"}
            </button>
            {/* A mint failure used to render in the same 12.5px muted grey as the explanation
                beside it, on the one card a guest is standing in front of. */}
            {mintError && (
              <span className="ev-error" role="alert">
                {mintError}
              </span>
            )}
            {walletsKitEnabled() && (
              <span className="ev-muted">Also live: fund a link from Freighter, LOBSTR or xBull (Stellar Wallets Kit).</span>
            )}
          </div>
        </div>

        <p className="stat-meta" style={{ marginTop: 28 }}>
          Refreshes every 30 seconds.{" "}
          {real.state === "ok" || practice.state === "ok" ? "Last read " + new Date(Math.max(real.state === "ok" ? real.at : 0, practice.state === "ok" ? practice.at : 0)).toLocaleTimeString() + "." : ""}
        </p>
      </div>
    </section>
  );
}
