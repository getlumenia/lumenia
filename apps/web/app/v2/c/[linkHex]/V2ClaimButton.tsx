"use client";

/**
 * The v2 claim action. Reads the link's #fragment, strips it from the URL immediately, and on tap
 * runs the walletless/gasless v2 claim: a fresh sponsored account is created for the recipient and
 * the drop is paid straight into it via the /v2-claim relayer. The claimed account is persisted
 * locally (Phase 1) so /home shows it. No wallet, no gas.
 *
 * Two kinds of link arrive here (see lib/claim-password.ts):
 *   - a plain bearer link — the fragment IS the key, and this is one tap, unchanged.
 *   - a password-locked link — the fragment is only half the key. The other half is the password
 *     the sender shared some other way, and the key is derived from both, on this device. A wrong
 *     password fails here, locally, against the link id in the URL: nothing is sent, nothing leaks,
 *     and no wrong guess ever reaches the escrow.
 *
 * Every tap that reaches the relayer mints a fresh sponsored account and trustline, so a tap that
 * cannot succeed is not free. The escrow's own answer decides what this screen says and whether a
 * retry button exists at all: a drop that has already been claimed, expired or was never there is
 * a final answer, not a failure to try again.
 *
 * It also renders the HEADER (who sent it, how much), because since D2 neither may come from the
 * server: whatever the server renders is what every link-preview bot receives. The name is read
 * here from the #fragment (or, on a legacy or rich link, from the query), and the amount from the
 * escrow itself (one-to-one: loadDrop; a pot: loadPool, one share). Until the escrow answers the
 * header says it is reading, and a read that fails says so in one line and shows no figure at all:
 * a guessed amount on a page with our domain and a working Claim button is the one thing this
 * screen must never print. The first render matches the server's (no name, no amount) so hydration
 * never disagrees with it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  claimV2ToSponsoredAccount,
  isTerminalClaimOutcome,
  loadDrop,
  loadPool,
  readClaimLatch,
  readClaimProgress,
  splitGroupHint,
  type PoolState,
  type ResumeDecision,
  type V2ClaimOutcome,
  type V2LinkKind,
} from "../../../../lib/lumendrop";
import { readClaimQuery } from "../../../../lib/link-fragment";
import { afterPatience, afterSettled, decideDrop, keepAnswer, withAnswer, type LedgerRead } from "../../../../lib/claim-ledger";
import { parseLinkFragment, unlockLink } from "../../../../lib/claim-password";
import { classifyClaimError, type ClaimErrorInfo } from "../../../../lib/claim-error";
import { copy } from "../../../../lib/copy";
import { formatUsd } from "../../../../lib/money";
import { getHome, savePhase1 } from "../../../../lib/keystore";
import { isSeededLink, sendEvent } from "../../../../lib/events";
import { resolveNetwork, setActiveNetwork, type NetworkConfig } from "../../../../lib/network";

const SPONSOR_URL = process.env.NEXT_PUBLIC_SPONSOR_URL ?? "https://lumenia-sponsor.avakit.workers.dev";
const explorer = (hash: string, net: NetworkConfig) =>
  `https://stellar.expert/explorer/${net.isMainnet ? "public" : "testnet"}/tx/${hash}`;

type State = "idle" | "unlocking" | "claiming" | "done" | "settled" | "error";

/* What the escrow has said about the amount so far, and the rules for what the screen may say about
   it, live in lib/claim-ledger.ts (pure, held by its self-test). */

/* How often an unanswered read is asked again. A link opened seconds after it was made can reach an
   RPC node that has not seen the deposit yet, so the screen keeps asking for about half a minute; its
   honest line shows after LEDGER_PATIENCE_MS and a later answer still replaces it. */
const LEDGER_ATTEMPTS = 10;
const LEDGER_RETRY_MS = 3_000;
/* A read with no answer at all is reported after this long, rather than "reading" forever. A late
   answer still replaces the line. */
const LEDGER_PATIENCE_MS = 10_000;

/** A settled drop is not a failed claim, so it gets its own words and no way to try again. */
type SettledKind = Exclude<V2ClaimOutcome["kind"], "claimed">;

function settledCopy(
  kind: SettledKind,
  sender: string,
  /** Which escrow answered. A pool and a one-to-one link settle for different reasons. */
  link: V2LinkKind,
  /** The drop's amount as the escrow reported it, when the screen read it before anyone tapped. */
  amount?: string,
): { title: string; body: string; home: boolean } {
  switch (kind) {
    case "already-yours":
      /* The ONE settled answer that may say where the money is. The escrow keyed a share to this
         device's own payout address, and no other device has it, so this is not the convenient
         guess, it is the contract's own record of an earlier attempt whose answer was lost. */
      return {
        title: "You already took your share",
        body: "It's in your account on this phone.",
        home: true,
      };
    case "already-claimed":
      if (link === "group") {
        /* A pool, not a used link: nobody "used" it, the shares ran out. The one-to-one wording
           below ("this link has already been used") would tell a whole queue of people that they
           are looking at their own earlier claim. */
        return {
          title: "Every share has been taken",
          body: `All the shares on this link are gone. Ask ${sender} to open another one.`,
          home: false,
        };
      }
      /* Deliberately not "it's in your account". The escrow keeps ONE flag and both exits set it:
         a recipient's `claim` and the sender's post-expiry `reclaim` leave a drop in the identical
         state, and `get_drop` returns no payout address to separate them. The only thing that
         would — `reclaim` is refused before expiry, so a drop settled early can only have been
         claimed — is not carried on the claim result this screen receives. So the words name both
         outcomes and /home answers which, honestly empty if the money went back. */
      if (amount) {
        /* Read up front, before anyone tapped: the escrow still holds the record and marks it
           claimed, so the figure is the ledger's own. Same two outcomes, same honesty. */
        return {
          title: "This link has already been used",
          body: `The ${formatUsd(amount)} on it is no longer waiting here. It was claimed, or ${sender} took it back after the link expired. If you claimed it on this phone, it's in your account.`,
          home: true,
        };
      }
      return {
        title: "This link has already been used",
        body: `This money is no longer waiting here — it was claimed, or ${sender} took it back after the link expired. If you claimed it on this phone, it's in your account.`,
        home: true,
      };
    case "expired":
      if (link === "group") {
        /* The closing time is the gate that keeps a take-back and a claim from both being paid out
           of the same escrow balance, so it is refused from the second it passes, seats left or
           not. The money is not lost: it is the sender's to take back, and only theirs. */
        return {
          title: "This link has closed",
          body: `Shares stopped at the closing time, and whatever was left is ${sender}'s to take back. Ask them to open another one.`,
          home: false,
        };
      }
      /* The group-drop answer: a share stops being claimable at expiry. A one-to-one drop has no
         such gate — it stays claimable until the sender takes it back — so it never lands here. */
      return {
        title: "This link has expired",
        body: `This one can't be claimed any more, and ${sender} can take the money back now that it's expired. Ask them to send it again.`,
        home: false,
      };
    case "no-such-drop":
      /* No escrow holds a record for this link. That covers a drop that settled and was later
         cleared AND one that was never funded at all, and nothing on chain says which — so this
         says neither. Naming a claim or a take-back here would be a history the ledger never
         reported. */
      return {
        title: "There's nothing on this link",
        body: `We can't find any money held for this link — it may already have been paid out, or this link may never have carried any. Ask ${sender} for a new one.`,
        home: false,
      };
    default:
      /* A settled answer this screen has no words for yet. Say only what every settled answer has
         in common, never the convenient guess about where the money went. */
      return {
        title: "This link isn't paying out",
        body: `Nothing can be claimed from this link. Ask ${sender} for a new one.`,
        home: false,
      };
  }
}

export default function V2ClaimButton({
  linkHex,
  slots,
  real,
}: {
  linkHex: string;
  /**
   * What the LINK says it holds: a pot of this many shares, or null for a one-to-one link. A hint
   * and nothing more, it decides which escrow view is asked first and what this screen renders
   * while it waits. The escrow's own answer decides what gets signed.
   */
  slots: number | null;
  /** `n=public`: the badge says real money. The claim itself resolves the network from the URL. */
  real: boolean;
}) {
  const [state, setState] = useState<State>("idle");
  /* WHO SENT IT, read in the browser only (see the note at the top). "Someone" until the fragment is
     read, and the line stays invisible until then, so a name never flickers in over a placeholder
     and the server's HTML, which every preview bot receives, never carries one. */
  const [sender, setSender] = useState("Someone");
  const [mounted, setMounted] = useState(false);
  /** The link says it is locked (`p=1` after the '#', or in a legacy/rich query). Display only. */
  const [lockMarked, setLockMarked] = useState(false);
  /** The rendering copy of `isGroup` below, which is a ref and so cannot re-render anything. */
  const [group, setGroup] = useState(slots !== null);
  /** The amount, as the escrow reports it. Never from the URL. */
  const [ledger, setLedger] = useState<LedgerRead>({ phase: "reading" });
  /* Set the moment a claim or an unlock is accepted. After that, a ledger answer may still fill in
     the figure, but it must never swap the screen under the person (an "already used" read can be
     this very claim landing). */
  const touched = useRef(false);
  /** The figure is read once per mount (StrictMode runs the mount effect twice in development). */
  const readStarted = useRef(false);
  const gone = useRef(false);
  /* The account this claim creates, captured the instant the relayer reports it. A ref, not state:
     it is read inside the same async function that sets it, and a re-render would be pointless. */
  const claimedAccount = useRef<string | null>(null);
  const [hash, setHash] = useState("");
  const [noKey, setNoKey] = useState(false);
  /** The escrow's settled answer about this drop, and which escrow gave it. Null until one does. */
  const [settled, setSettled] = useState<{ kind: SettledKind; link: V2LinkKind; amount?: string } | null>(null);
  /**
   * Whether this link is a POT, decided before anything is spent: the `g` hint from the query, the
   * copy of it that rides in the fragment (chat apps trim queries and keep fragments), or this
   * device's own latch from an earlier attempt, which recorded which escrow answered.
   */
  const isGroup = useRef(false);
  /** The pool as the escrow has it right now. Null while unread, a count is never guessed. */
  const [pool, setPool] = useState<PoolState | null>(null);
  /**
   * What this phone already asked for on this link, resolved against the ledger. Only ever set from
   * `readClaimProgress`, which looks at the payout account and the escrow BEFORE it answers, so
   * "you already took your share" can never be printed off a request whose reply was lost.
   */
  const [resume, setResume] = useState<ResumeDecision | null>(null);
  /** Why the last attempt failed, when it failed for a reason that isn't the drop itself. */
  const [failure, setFailure] = useState<ClaimErrorInfo | null>(null);
  /** This deployment cannot serve the network this link names — no tap will change that. */
  const [unreachableNetwork, setUnreachableNetwork] = useState(false);
  const [locked, setLocked] = useState(false);
  const [password, setPassword] = useState("");
  const [wrongPassword, setWrongPassword] = useState(false);
  /** The derivation didn't run — a fact about this phone, never about the password. */
  const [unlockBroke, setUnlockBroke] = useState(false);
  // The link carries its own network (`?n=public`). The product is testnet; a handful of mainnet
  // links exist as real-money evidence, and this is what keeps one deployment able to serve both.
  const [net, setNet] = useState<NetworkConfig | null>(null);
  /* Beacon context, read once from the URL on mount (the fragment is stripped right after, and
     the query stays): the link's network (the only authority for where a claim beacon goes, since
     this phone has no prior state), whether the team funded this link for the event, and when the
     claim was opened, so the success beacon can carry a duration bucket. */
  const beacon = useRef<{ net?: NetworkConfig; seeded: boolean; openedAt: number }>({ seeded: false, openedAt: 0 });
  const secretRef = useRef("");
  const seedRef = useRef<Uint8Array | null>(null);
  /* Set the instant a tap is accepted, not on the re-render that follows it. A second tap lands
     inside the first one's `await`, where state is still whatever it was at paint — so two full
     claims used to run, each minting its own sponsored account and trustline, and whichever
     finished last painted over the other's result. */
  const inFlight = useRef(false);

  useEffect(() => {
    let resolved: NetworkConfig | null = null;
    try {
      resolved = resolveNetwork(new URLSearchParams(window.location.search).get("n"));
      setNet(resolved);
      beacon.current.net = resolved;
    } catch {
      setUnreachableNetwork(true);
    }
    beacon.current.seeded = isSeededLink(window.location.search);
    beacon.current.openedAt = Date.now();
    const frag = window.location.hash.slice(1);
    /* The `g` copy in the fragment comes off BEFORE the key parser sees it. That parser treats the
       whole fragment as the key, so an unsplit `S...&g=6` is simply a bad secret and every group link
       whose query a chat app trimmed would fail to open at all. The sender's name and the lock
       marker of a private link ride there too (`&s=`, `&p=1`), and come off the same way. */
    const carried = splitGroupHint(frag);
    const hinted = carried.slots ?? slots;
    /* A latch written by an earlier attempt records which escrow answered, so a link that arrived
       with no hint at all is still known to be a pool on the phone that already asked about it. */
    isGroup.current = hinted !== null || readClaimLatch(linkHex)?.link === "group";
    /* The name: the fragment's (a private link), else the query's (believed only on a legacy or a
       rich link, see readClaimQuery), else "Someone". The query's `a` is never read for anything.
       Skipped on a second run that finds the fragment already stripped (StrictMode in development),
       which would otherwise overwrite what the first run read with the fallback. */
    const firstRun = !readStarted.current;
    if (frag || firstRun) {
      const query = readClaimQuery(window.location.search);
      setSender(carried.from ?? query.queryName ?? "Someone");
      setLockMarked(carried.passwordLocked || query.queryLocked);
      setGroup(isGroup.current);
    }
    setMounted(true);
    if (frag) {
      const parsed = parseLinkFragment(carried.fragment);
      if (parsed?.kind === "password") {
        seedRef.current = parsed.seed;
        setLocked(true);
      } else if (parsed?.kind === "key") {
        secretRef.current = parsed.secret;
      } else {
        setNoKey(true);
      }
      history.replaceState(null, "", window.location.pathname + window.location.search);
      /* The TOP of the funnel: somebody arrived holding a real key. Fired only when a key is
         actually present, so a crawler or a link preview opening this URL is not counted as a
         person about to claim — the completion rate is only honest if the denominator is. There is
         no account yet, so this one carries the link id alone. It goes to the LINK's network: this
         phone's own flag is unset for a first-time recipient, and routing by it sent every mainnet
         claim to the testnet counters (the reason the mainnet summary read zero). */
      void sendEvent("claim_opened", linkHex, undefined, { net: beacon.current.net, seeded: beacon.current.seeded });
    } else if (!secretRef.current && !seedRef.current) {
      setNoKey(true);
    }
    /* THE AMOUNT, for every link: a private link no longer carries it, and the escrow is the only
       authority on it anyway. A read-only simulation (loadDrop for a one-to-one link, loadPool for a
       pot, which also gives the live share count), nothing is created and no sponsor request is
       made. Once per mount. */
    if (!readStarted.current) {
      readStarted.current = true;
      if (resolved) void readAmount(resolved, isGroup.current);
      else setLedger({ phase: "off" });
    }
    /* What this phone already asked for: a pot only. A read-only look at Horizon and the escrow, and
       it does not run on a one-to-one link, which keeps that claim exactly as it was. */
    if (isGroup.current && resolved) {
      void readClaimProgress(linkHex, { net: resolved, group: true })
        .then(({ decision }) => setResume(decision))
        .catch(() => {
          /* We could not look. Saying nothing is the honest outcome: the claim itself presents the
             same payout this device already asked for, so opening it again cannot pay twice. */
        });
    }
    gone.current = false;
    return () => {
      gone.current = true;
    };
    // Deliberately mount-only: it reads the URL fragment, which is stripped on the first pass, so a
    // re-run would find nothing and fire nothing. `linkHex` comes from the route and cannot change
    // without a remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Fill the header's figure from the escrow, asking again a few times while there is no answer.
   * A failed or empty read shows its honest line at once; a later answer replaces it.
   */
  async function readAmount(on: NetworkConfig, pot: boolean) {
    const patience = setTimeout(
      () => setLedger(afterPatience),
      LEDGER_PATIENCE_MS,
    );
    try {
      for (let attempt = 0; attempt < LEDGER_ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, LEDGER_RETRY_MS));
        if (gone.current) return;
        if (pot ? await refreshPool(on) : await readDropOnce(on)) return;
      }
    } finally {
      clearTimeout(patience);
    }
  }

  /** A reading that is not an answer never replaces one that is (lib/claim-ledger.ts keepAnswer). */
  const unlessAnswered = (next: LedgerRead) => (l: LedgerRead) => keepAnswer(l, next);
  /** An answer, unless the claim has already settled the screen (lib/claim-ledger.ts withAnswer). */
  const asAnswer = (next: LedgerRead) => (l: LedgerRead) => withAnswer(l, next);

  /** One look at a one-to-one drop. True when the escrow gave an answer worth keeping. */
  async function readDropOnce(on: NetworkConfig): Promise<boolean> {
    let d: Awaited<ReturnType<typeof loadDrop>>;
    try {
      d = await loadDrop(linkHex, { net: on });
    } catch {
      setLedger(unlessAnswered(decideDrop({ kind: "error" }, touched.current).ledger));
      return false;
    }
    /* No drop, and nothing ever said this link is a pot: a hand-edited link can have lost every `g`
       hint, so the pool is asked once before the screen says the ledger shows no money. (The tap
       already probes both; this only keeps the header honest.) */
    if (!d && !isGroup.current) {
      try {
        const p = await loadPool(linkHex, { net: on });
        if (p) {
          isGroup.current = true;
          setGroup(true);
          setPool(p);
          setLedger(asAnswer({ phase: "amount", amount: p.perShare }));
          return true;
        }
      } catch {
        /* the drop answer stands */
      }
    }
    const decision = decideDrop(
      d ? { kind: "drop", amount: d.amount, claimed: d.claimed } : { kind: "none" },
      touched.current,
    );
    if (decision.settle) {
      /* Spent before anyone here tapped: the settled screen up front, with the escrow's figure, and
         no button that could only buy a sponsored account to be told the same thing. */
      setLedger(decision.ledger);
      setSettled({ kind: "already-claimed", link: "single", amount: decision.settle.amount });
      setState((s) => (s === "idle" ? "settled" : s));
      return true;
    }
    setLedger(decision.answered ? asAnswer(decision.ledger) : unlessAnswered(decision.ledger));
    return decision.answered;
  }

  /**
   * The live share count and the per-share figure, straight from the escrow. A read we could not
   * finish shows no count. True when the escrow gave an answer.
   */
  async function refreshPool(on: NetworkConfig): Promise<boolean> {
    try {
      const p = await loadPool(linkHex, { net: on });
      if (p) {
        setPool(p);
        setLedger(asAnswer({ phase: "amount", amount: p.perShare }));
        return true;
      }
      setLedger(unlessAnswered({ phase: "none" }));
    } catch {
      /* the escrow is the authority on this number, and a stale one is worse than none */
      setLedger(unlessAnswered({ phase: "unread" }));
    }
    return false;
  }

  async function claimWith(secret: string) {
    setState("claiming");
    setFailure(null);
    try {
      if (!net) throw new Error("Still loading. Please tap again.");
      const outcome = await claimV2ToSponsoredAccount({
        linkSecret: secret,
        sponsorUrl: net.isMainnet ? net.sponsorUrl : SPONSOR_URL,
        net,
        /* A probe hint, not an instruction: it says which escrow view to ask FIRST. What the escrow
           answers is what decides the tag this claim signs, a wrong guess here would sign bytes a
           pool rejects, after a sponsored account had already been paid for. */
        group: isGroup.current,
        /* Save the key the MOMENT the account exists, before the money is sent to it. If the claim
           then fails or the connection drops, the worst case is an empty account on this phone —
           not money sitting somewhere whose only key we threw away. */
        onAccountReady: async (publicKey, seed) => {
          claimedAccount.current = publicKey;
          try {
            /* With no home on this device the claim's account becomes it, and is the person's own
               account from here on: kept as "user", it can never later read as a sweepable throwaway
               (a kindless record is "user" only while it is the active one, lib/keystore.ts kindOf).
               With a home it stays kindless, the throwaway /home gathers in, as before. */
            await savePhase1(publicKey, seed, (await getHome()) ? undefined : "user");
          } catch {
            /* storage blocked (private mode, a locked-down webview). Not fatal, and NOT a reason to
               tell someone their claim failed — the money still moves and the receipt still shows
               the address. */
          } finally {
            seed.fill(0);
          }
        },
      });

      if (outcome.kind !== "claimed") {
        if (!isTerminalClaimOutcome(outcome)) {
          /* An answer this screen has no words for. "Try again" is the only honest advice left, and
             it is safe: nothing was created, because the escrow was asked first. */
          setFailure({ kind: "unknown", detail: outcome.kind, retryable: true });
          setState("error");
          return;
        }
        /* The drop is spent, gone or past its window — and the escrow said so BEFORE anything was
           minted for it. No `claim_failed` beacon: this is a settled drop, not a claim that failed,
           and counting a second look at money already taken as a failure would understate the very
           funnel this route was instrumented to measure. */
        setSettled({ kind: outcome.kind, link: outcome.link });
        setLedger(afterSettled());
        setState("settled");
        return;
      }
      outcome.seed.fill(0); // the callback already stored it; don't keep a second copy around

      /* The money is on MAINNET but this device's flag still says practice, so /home would read the
         testnet ledger and greet a recipient who just received real dollars with "$0.00". The link
         is the only thing that knows which network this was, so the moment it lands is the only
         moment we can set it. */
      setActiveNetwork(net.id);

      setHash(outcome.hash);
      setState("done");
      /* THE FUNNEL'S INPUT SIDE, which this route did not have. v2 is the live money loop — every
         link /send hands out today is a v2 link — and it emitted no events at all, so "how many
         people claimed" was being answered from the v1 route almost nobody arrives on any more.
         The account goes with it: it is the id that joins a claim to whatever that person does
         next, and this is the moment it comes into existence. */
      /* `outcome.publicKey` first, because a RESUMED claim reuses the payout this device already
         made and therefore never calls `onAccountReady`, reading the ref alone would drop the
         account id off exactly the claims a lost response produced. */
      void sendEvent("claim_succeeded", linkHex, outcome.publicKey || claimedAccount.current || undefined, {
        net,
        seeded: beacon.current.seeded,
        // Open-to-balance on THIS device, in whole seconds; the sponsor keeps only a bucket count.
        durationS: beacon.current.openedAt ? Math.round((Date.now() - beacon.current.openedAt) / 1000) : undefined,
      });
      // The shares the others still have, re-read from the escrow rather than counted down here.
      if (isGroup.current) void refreshPool(net);
      if (typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(30);
    } catch (e) {
      const info = classifyClaimError(e);
      // The classifier redacts bearer material; the raw error must never reach a console on this
      // route, because the link secret is one string substitution away from anything built here.
      console.warn("[v2-claim] failed:", info.kind, "—", info.detail);
      if (info.kind === "already-claimed") {
        /* The escrow answered "claimable" and the relayer then found it gone — another device won
           the race between the two. Same settled answer, so it gets the settled screen rather than
           a failure the recipient is invited to retry. */
        setSettled({ kind: "already-claimed", link: isGroup.current ? "group" : "single" });
        setLedger(afterSettled());
        setState("settled");
        return;
      }
      setFailure(info);
      setState("error");
      void sendEvent("claim_failed", linkHex, claimedAccount.current ?? undefined, { net: beacon.current.net, seeded: beacon.current.seeded });
    }
  }

  async function onClaim() {
    if (inFlight.current) return;
    touched.current = true;
    const secret = secretRef.current;
    if (!secret) {
      setFailure({ kind: "link-invalid", detail: "missing key", retryable: false });
      setState("error");
      return;
    }
    inFlight.current = true;
    try {
      await claimWith(secret);
    } finally {
      inFlight.current = false;
    }
  }

  async function onUnlock() {
    if (inFlight.current) return;
    const seed = seedRef.current;
    if (!seed || !password) return;
    touched.current = true;
    setWrongPassword(false);
    setUnlockBroke(false);
    setState("unlocking");
    inFlight.current = true;
    try {
      // Deriving the key is deliberately slow (memory-hard) — that slowness IS the
      // protection, since guessing happens on the guesser's own device.
      let result: Awaited<ReturnType<typeof unlockLink>>;
      try {
        result = await unlockLink(seed, password, linkHex);
      } catch (e) {
        /* 48 MiB of Argon2id WASM is the one step this screen cannot do everywhere: a memory-tight
           in-app webview — the surface most of these links are opened in — can refuse the
           allocation outright. Unhandled, the rejection left "Checking…" on screen forever, on the
           one screen that must never dead-end. Only a mismatched key is evidence about the
           password; this is evidence about the phone, and it says so. */
        console.warn("[v2-unlock] derivation failed:", (e as Error)?.name ?? "error");
        setUnlockBroke(true);
        setState("idle");
        return;
      }
      if (!result.ok) {
        setWrongPassword(true);
        setState("idle");
        return;
      }
      secretRef.current = result.secret;
      setPassword("");
      await claimWith(result.secret);
    } finally {
      inFlight.current = false;
    }
  }

  /**
   * How many shares the escrow says are left, or nothing at all.
   *
   * Only rendered from a live read, and only while the pool is open: "0 shares left" over a link
   * the sender took the leftover back from would be the ledger's numbers telling a story that never
   * happened (`reclaim_pool` marks every slot claimed as it closes). Between two reads it can be
   * one behind, which is why the escrow is asked again before anything is spent.
   */
  const sharesLeft =
    pool && pool.status === "open" ? (
      <p className="text-sm font-medium text-ink">
        {pool.sharesLeft} {pool.sharesLeft === 1 ? "share" : "shares"} left
      </p>
    ) : null;

  /**
   * Who sent it and how much, above every state of the action. Nothing here comes from the server
   * (see the note at the top): the name from the link, the figure from the escrow, and only after
   * mount, so the server's render and the first client render are the same skeleton.
   */
  const header = (
    <div className="flex flex-col items-center gap-2">
      {/* Which network, before anything else: real dollars and practice dollars must never look
          alike on the one screen a stranger sees (hackathon build, 2026-09-19). */}
      <span
        className={`mb-2 rounded-full border px-3 py-0.5 text-xs font-semibold ${real ? "border-money text-money" : "border-line text-ink-soft"}`}
      >
        {real ? "Real money" : "Practice money"}
      </span>
      {/* Invisible, not absent, until the link is read: the line keeps its height, so nothing jumps
          when the name arrives, and "Someone" never flashes in front of the real one. */}
      <p className={mounted ? "text-ink-soft" : "invisible text-ink-soft"}>
        {group ? `${sender} sent money to a group` : `${sender} sent you money`}
      </p>
      {ledger.phase === "amount" ? (
        <>
          <p className="text-6xl font-bold tabular-nums text-money">{formatUsd(ledger.amount)}</p>
          {/* On a pot, the 60px figure is ONE share, never the pot, which nobody here receives. */}
          {group ? <p className="text-sm text-ink-soft">That&apos;s one share of this link.</p> : null}
          <p className="text-xs font-medium text-ink-soft">Verified on the ledger</p>
        </>
      ) : ledger.phase === "reading" ? (
        // The figure's own height, so the page does not jump when it lands.
        <p className="flex min-h-[3.75rem] items-center text-sm text-ink-soft" role="status">
          Reading the amount from the ledger
        </p>
      ) : ledger.phase === "unread" ? (
        <p className="text-sm text-ink-soft">We couldn&apos;t read the amount from the ledger just now.</p>
      ) : ledger.phase === "none" ? (
        <p className="text-sm text-ink-soft">The ledger shows no money on this link right now.</p>
      ) : null}
      <p className="mt-1 text-sm font-medium text-ink">No app. No wallet. You pay nothing.</p>
      {(lockMarked || locked) && (
        <p className="mt-2 text-sm text-ink-soft">
          {group
            ? `This one is locked. You'll need the word ${sender} gave the group.`
            : `This one is locked. You'll need the password ${sender} gave you.`}
        </p>
      )}
    </div>
  );
  /* The header and the action are siblings, as they were when the header was server-rendered, so
     the page's own spacing between them is unchanged. */
  const withHeader = (action: ReactNode) => (
    <>
      {header}
      {action}
    </>
  );

  if (state === "unlocking") {
    return withHeader(<p className="py-4 text-money">{"Checking\u2026"}</p>);
  }

  if (state === "claiming") {
    return withHeader(<p className="py-4 text-money">{"Moving your money\u2026"}</p>);
  }

  if (state === "done") {
    return withHeader(
      <div className="flex w-full flex-col items-center gap-4">
        <p className="text-lg font-semibold text-money">It&apos;s yours 🎉</p>
        {/* The receipt says what just happened on chain, in plain words: the sponsor paid the
            network fee and the reserve, and the account is new. Every v2 claim creates a fresh
            sponsored account (claimV2ToSponsoredAccount), so the second line is always true here. */}
        <div className="flex flex-col items-center gap-0.5 text-sm text-ink-soft">
          <p>Network fee: $0.00, covered by Lumenia.</p>
          <p>Your account was just created on Stellar. You didn&apos;t need XLM.</p>
        </div>
        <a
          href={explorer(hash, net ?? resolveNetwork(undefined))}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-ink-soft underline-offset-2 hover:underline"
          data-tx-hash={hash}
        >
          See the public record ↗
        </a>
        {/* What is left for the people still in the queue, read from the escrow after the claim. */}
        {sharesLeft}
        <Link
          href="/home"
          prefetch={false}
          className="flex h-12 w-full items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
        >
          See my money
        </Link>
      </div>
    );
  }

  if (state === "settled" && settled) {
    const said = settledCopy(settled.kind, sender, settled.link, settled.amount);
    return withHeader(
      <div className="flex w-full flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-lg font-semibold text-money">{said.title}</p>
          <p className="text-ink-soft">{said.body}</p>
        </div>
        {said.home && (
          <Link
            href="/home"
            prefetch={false}
            className="flex h-12 w-full items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
          >
            {/* Not "See my money": the screen above it can't promise there is any. */}
            Check my account
          </Link>
        )}
      </div>
    );
  }

  /* WHAT THIS PHONE ALREADY ASKED FOR, and only what somebody went and looked at.
   *
   * The latch that produced this was written BEFORE the relay call, because the response is the
   * thing that gets lost, but it asserts nothing about where the money is. `readClaimProgress`
   * turns it into an answer by reading the payout account's balance on the LINK's network and then
   * the escrow, so "it's in your account on this phone" is a balance somebody read. A read that did
   * not finish answers "unsure", which offers the claim and promises nothing. */
  if (state === "idle" && resume?.say === "taken") {
    return withHeader(
      <div className="flex w-full flex-col items-center gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-lg font-semibold text-money">You already took your share</p>
          <p className="text-ink-soft">
            {formatUsd(resume.usd)} is in the account this phone made for it.
          </p>
        </div>
        <Link
          href="/home"
          prefetch={false}
          className="flex h-12 w-full items-center justify-center rounded-full bg-money text-sm font-semibold text-primary-foreground"
        >
          See my money
        </Link>
      </div>
    );
  }

  if (state === "idle" && resume?.say === "missed") {
    return withHeader(
      <div className="flex w-full flex-col items-center gap-3 text-center">
        <p className="text-lg font-semibold text-money">Your share didn&apos;t land</p>
        <p className="text-ink-soft">
          Nothing arrived in the account this phone made, and the link can&apos;t pay out any more.
          Ask {sender} for another one.
        </p>
      </div>
    );
  }

  /* A failure that cannot succeed on retry gets no button. Offering one is an invitation to fail
     again, and here it is worse than cosmetic: each tap that reaches the relayer mints another
     sponsored account and trustline at the sponsor's expense. */
  const canRetry = state !== "error" || failure?.retryable !== false;

  /**
   * What the one button says.
   *
   * A pot names the share ("Take my share") rather than the figure: the amount on screen is one
   * share, and "Take $15.00" next to a $90 pot invites the reading that the pot is what moves. The
   * one-to-one label is the live money loop's, and the claim end-to-end tests match on both of its
   * forms: "Take <figure>" once the ESCROW has named the figure (never the URL), and "Claim my
   * money" until it has, or when it could not.
   */
  const claimLabel =
    state === "error"
      ? copy.claim.retry
      : resume?.say === "resume"
        ? "Finish taking my share"
        : group
          ? "Take my share"
          : ledger.phase === "amount"
            ? `Take ${formatUsd(ledger.amount)}`
            : "Claim my money";

  /** A resume is one tap that presents the SAME payout, so it cannot pay this person twice. */
  const resumeNote =
    // Without a key there is no button under it, and a sentence about tapping again would be about
    // an action this screen is not offering.
    state !== "idle" || noKey || unreachableNetwork
      ? null
      : resume?.say === "resume"
        ? "You opened this before and we never saw the answer. Taking it again asks for the same account, so it can't pay you twice."
        : resume?.say === "unsure"
          ? "We couldn't check what happened here just now. Taking it again asks for the same account, so it can't pay you twice."
          : null;

  const failureBody = (() => {
    switch (failure?.kind) {
      case "busy":
        return copy.claim.errBusyBody;
      case "network-busy":
        return copy.claim.errNetworkBusyBody;
      case "day-limit":
        return copy.claim.errDayLimitBody;
      case "paused":
        return copy.claim.errPausedBody;
      case "offline":
        return copy.claim.errOfflineBody;
      case "link-invalid":
        return copy.claim.errLinkBody;
      /* THE POOL'S OWN REFUSALS (the relayer's tokens, classified in lib/claim-error.ts). Every one
         of them is the escrow's settled answer about this claim, so none offers a retry, and on a
         pool a retry is not a wasted tap, it is another sponsored account bought to be told the
         same thing. The words differ because the next step does. */
      case "pool-empty":
        return `Someone took the last share while you were opening this one. Ask ${sender} for another link.`;
      case "already-yours":
        return "Your share is already in the account this phone made for it. Open your money to see it.";
      case "expired":
        return `This link closed, so it can't pay out any more. Whatever was left is ${sender}'s to take back.`;
      case "link-mismatch":
        return `This link doesn't match the money it points at. Ask ${sender} for a new one.`;
      case "group-failed":
        return `The link refused this claim, and asking again can't change that. Ask ${sender} for a new one.`;
      case "uncertain":
        // The relayer stopped watching; the claim may still be landing. Reopening the link reads the
        // account and the escrow before it says anything, which is the only honest next step.
        return copy.claim.errUncertainBody;
      case "refused":
        // We stopped before putting a signature on anything, so "try again" would be false advice:
        // the same answer refuses the same way. Nothing about the money changed.
        return "We stopped before signing anything — what came back didn't match what this app asked for. Your money is untouched. Open the link from the original message again a little later.";
      default:
        // Cause unknown — and then the old wording is the honest one: the escrow was asked before
        // anything was created, so the money has not moved and trying again is reasonable.
        return copy.claim.error(sender);
    }
  })();

  return withHeader(
    <div className="flex w-full flex-col items-center gap-3">
      {/* The live count sits above the action, where the decision is made. Absent until a real read
          lands, and absent again once the pool is no longer open. */}
      {sharesLeft}
      {resumeNote && <p className="text-sm text-ink-soft">{resumeNote}</p>}
      {unreachableNetwork ? (
        <p className="text-sm text-ink-soft">
          This link is for a network this site cannot reach right now.
        </p>
      ) : noKey ? (
        <p className="text-sm text-ink-soft">Open your original link to claim this money.</p>
      ) : !canRetry ? null : locked ? (
        <>
          {group ? (
            /* A pot's secret is one word the whole group was told out loud, not a password for one
               person. Built as a single string so the spacing cannot break the way the one below
               once did. */
            <p className="text-sm text-ink-soft">
              {`${sender} put a word on this one. Ask anyone in the group if you don't have it - it was said separately, not in this link.`}
            </p>
          ) : (
            <p className="text-sm text-ink-soft">
              {/* Explicit {" "}: the text block below contains an entity (&apos;), which splits it
                  into fragments and drops the leading space, this shipped as "Mericput a password"
                  and was caught by watching the demo film rather than by reading the code. */}
              {sender}
              {" "}put a password on this one. Ask them for it if you don&apos;t have it. They sent it
              separately, not in this link.
            </p>
          )}
          <input
            type="password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setWrongPassword(false);
              setUnlockBroke(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void onUnlock();
            }}
            autoComplete="off"
            placeholder="Password"
            aria-label="Password"
            className="h-12 w-full rounded-full border border-line bg-surface px-5 text-center text-base text-ink outline-none"
          />
          {wrongPassword && (
            <p className="text-sm text-danger">That password doesn&apos;t match. Try again.</p>
          )}
          {unlockBroke && (
            <p className="text-sm text-danger">
              We couldn&apos;t check the password on this phone just now. Try again, or open this
              link in your browser.
            </p>
          )}
          <button
            onClick={onUnlock}
            disabled={!password}
            data-link={linkHex}
            className="h-14 w-full rounded-full bg-money px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-money/90 active:bg-money-pressed disabled:opacity-50"
          >
            {/* The locked one-to-one label is left exactly as it was; only a pot renames it. */}
            {group ? "Take my share" : "Claim my money"}
          </button>
        </>
      ) : (
        <button
          onClick={onClaim}
          data-link={linkHex}
          className="h-14 w-full rounded-full bg-money px-8 text-base font-semibold text-primary-foreground transition-colors hover:bg-money/90 active:bg-money-pressed"
        >
          {claimLabel}
        </button>
      )}
      {state === "error" && failure && (
        <div className="flex flex-col items-center gap-1 text-center">
          <p className="text-sm text-danger">{failureBody}</p>
          {/* Small, muted, and deliberately present: it is what turns "it didn't work" into a
              report we can act on. */}
          {failure.detail && (
            <p className="text-xs text-ink-soft opacity-70">{copy.claim.errDetail(failure.detail)}</p>
          )}
        </div>
      )}
    </div>
  );
}
