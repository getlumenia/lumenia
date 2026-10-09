/**
 * What each refusal MEANS for the person, in words, with the one thing they can do about it.
 *
 * The worker already answers in plain sentences (lib/errors.ts). We use its sentence when it is one
 * (format.plainSentence) and our own when it is not, so a status code or a ledger term can never
 * reach a money screen. The title and the action are always ours. `uncertain` is never reworded:
 * it is the one message that must stop a second send.
 */
import { CAPS_SENTENCE } from "../lib/copy";
import type { ErrorCode, NetId } from "../lib/types";
import { plainSentence } from "./format";

/** What the single button on a problem panel does. The shell owns what each one means. */
export type ProblemAction =
  | "back" // dismiss the panel, keep the form as it was
  | "links" // open Links
  | "join" // open the pilot page on the web
  | "refresh" // re-read the worker (it will route to Unlock, Consent or Connect)
  | "practice" // ask for practice dollars, then back to the form
  | "use-practice" // switch to practice money, then back to the form
  | "web-settings" // open Lumenia settings on the web
  | "settings" // open Settings here
  | "backup"; // open the backup steps here

export interface Problem {
  code: ErrorCode;
  title: string;
  body: string;
  action: ProblemAction;
  label: string;
}

const UNCERTAIN =
  "We sent it, but couldn't confirm it yet. Don't send it again. We'll keep checking, and it will show up in Links.";

export function describeProblem(code: ErrorCode, message: string, net: NetId): Problem {
  const real = net === "public";
  const worker = plainSentence(message);
  const make = (title: string, own: string, action: ProblemAction, label: string, preferOwn = false): Problem => ({
    code,
    title,
    body: preferOwn ? own : (worker ?? own),
    action,
    label,
  });

  switch (code) {
    case "uncertain":
      return make("We couldn't confirm it yet", UNCERTAIN, "links", "See links", true);
    case "halted":
      return make("Paused for now", "Sending is paused right now. Your money hasn't moved. Try again later.", "back", "Back");
    /* Two waits that used to read as the pause above: a congested network is not Lumenia pausing,
       and a spent day limit is not "later", it is tomorrow. */
    case "network-busy":
      return make("The network is busy", "The network is busy right now. Your money hasn't moved. Try again in a moment.", "back", "Back", true);
    case "day-limit":
      return make(
        "That's all for today",
        "Lumenia has reached today's limit on what it can cover. Your money hasn't moved. Try again tomorrow, after midnight UTC.",
        "back",
        "Back",
        true,
      );
    case "needs-backup":
      return make(
        "Back it up first",
        "Real money needs this account backed up first. Until then it lives only in this browser, and losing the browser would lose the money.",
        "backup",
        "Back it up",
        true,
      );
    case "not-approved":
      // The same code is used when the real-money note was never accepted; that one is fixed in Settings.
      if (/settings|accept/i.test(message)) {
        return make("One step first", "Read the real-money note in Settings and accept it first.", "settings", "Open settings");
      }
      return make(
        "Not on the list yet",
        "Real money is invite-only for now, and this account isn't approved yet.",
        "join",
        "Ask to join",
      );
    case "slots-used":
      return make(
        "No real-money sends left",
        "You've used all your real-money sends in the pilot. Practice money still works.",
        "use-practice",
        "Use practice money",
      );
    case "over-cap":
      return make(
        "That's over the limit",
        `${CAPS_SENTENCE} Try a smaller amount.`,
        "back",
        "Change the amount",
      );
    case "rate-limited":
      return make("Slow down a moment", "Too many tries in a minute. Wait a moment, then try again.", "back", "Back");
    case "offline":
      return make(
        "Couldn't connect",
        "We couldn't reach Lumenia. Your money hasn't moved. Check your connection and try again.",
        "back",
        "Back",
      );
    case "not-enough-money":
      return real
        ? make("Not enough money", "That's more than you have.", "back", "Change the amount")
        : make("Not enough money", "That's more than you have. Practice dollars are free.", "practice", "Get practice dollars", true);
    case "account-not-found":
      return real
        ? make(
            "Your account isn't open here yet",
            "This account isn't on real money yet. Add dollars to it on getlumenia.com first.",
            "web-settings",
            "Open getlumenia.com",
          )
        : make(
            "Your account isn't open here yet",
            "This account isn't open on practice money yet. Get some practice dollars to open it.",
            "practice",
            "Get practice dollars",
            true,
          );
    case "simulation-failed":
      return make(
        "We couldn't set that up",
        "We couldn't prepare that transfer. Your money hasn't moved. Check your balance and try again.",
        "back",
        "Back",
      );
    case "sponsor-refused":
      return make("Lumenia didn't take that", "It did not go through. Nothing moved, so you can send it again.", "back", "Back");
    case "needs-consent":
      return make("One thing first", "Read and agree to what this extension sends before it can do anything.", "refresh", "Review");
    case "locked":
      return make("Your account is locked", "Unlock first. Your key is locked after a few minutes without use.", "refresh", "Unlock");
    case "needs-password":
      return make(
        "Real money needs a password lock",
        "Real money needs an account locked with a password. You can add one on getlumenia.com.",
        "web-settings",
        "Open Lumenia settings",
      );
    case "pilot-unknown":
      return make(
        "We couldn't check your access",
        "We couldn't check whether real money is open for this account. Try again in a minute.",
        "back",
        "Back",
      );
    case "no-account":
      return make("No account here yet", "Restore your Lumenia account first.", "refresh", "Continue");
    case "host-access":
      return make("One permission needed", "Allow Lumenia to reach its servers first.", "refresh", "Continue");
    case "busy":
      return make("Still making a link", "A link is still being made. Wait for it to finish.", "links", "See links");
    case "open-send":
      return make(
        "An earlier link isn't confirmed yet",
        "A link you made earlier isn't confirmed yet. If it went through, a new one puts the money in twice. Check Links first, or choose to send a new one anyway.",
        "back",
        "Back",
        true,
      );
    case "open-links":
      return make("Some links are still open", "Take them back or wait until they are claimed before you forget this account.", "links", "See links");
    default:
      return make("That didn't finish", "Something went wrong. Try again.", "back", "Back");
  }
}
