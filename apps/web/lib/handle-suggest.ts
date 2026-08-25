/**
 * Name suggestions for onboarding (docs/IDENTITY_AND_ACCOUNTS.md §3).
 *
 * WHY SUGGESTIONS EXIST AT ALL. "Pick a name" is a blank field, and a blank field is the slowest
 * question in any sign-up — people stall, try three taken names, and leave. Three tappable names
 * that are already known to be free turns the step into a choice, and a choice takes a second.
 * Skipping stays equally available: a name is useful, never required.
 *
 * THE GENERATOR MUST AGREE WITH THE REGISTRY, or it hands people names that get refused at the
 * button. Everything it produces satisfies the registry's shape rule — 3–20 characters, starts with
 * a letter, only `a–z 0–9 _` — and the word lists deliberately avoid the reserved vocabulary
 * (money, pay, bank, admin, support …). Availability is still CHECKED against the live registry
 * before a suggestion is shown, because the shape rule cannot know what somebody else took first.
 *
 * The lists are warm, neutral and unmistakably not-a-person: nature, weather, small animals. No
 * words about money, no words that could read as an official Lumenia account, and nothing that
 * turns unpleasant in combination.
 */
import { checkHandle } from "./handles";

/** Registry shape: 3–20 chars, starts with a letter, `a–z 0–9 _`. Pinned by the selftest. */
const SHAPE = /^[a-z][a-z0-9_]{2,19}$/;

const ADJECTIVES = [
  "amber", "brave", "bright", "calm", "clever", "cosy", "daily", "early", "easy", "fair",
  "fond", "fresh", "gentle", "glad", "golden", "happy", "honest", "kind", "lively", "lucky",
  "merry", "mild", "neat", "noble", "open", "plain", "quick", "quiet", "rapid", "ready",
  "roving", "sharp", "silver", "smooth", "snowy", "soft", "sunny", "swift", "tidy", "true",
  "warm", "wise", "young", "zesty",
];

const NOUNS = [
  "acorn", "anchor", "arbor", "aspen", "badger", "beacon", "birch", "bison", "bramble", "breeze",
  "brook", "cedar", "cinder", "cloud", "clover", "comet", "coral", "cove", "crane", "dawn",
  "delta", "dune", "ember", "falcon", "fern", "ferry", "finch", "fjord", "garden", "glade",
  "harbor", "hazel", "heron", "hollow", "island", "juniper", "kite", "lantern", "lark", "linden",
  "maple", "meadow", "moth", "orchard", "otter", "owl", "pebble", "pine", "poppy", "puffin",
  "quill", "raven", "reef", "ridge", "river", "robin", "sable", "sailor", "sparrow", "spruce",
  "swallow", "thistle", "tulip", "vale", "walnut", "willow", "wren",
];

/** Cryptographic randomness, because Math.random() in a suggestion loop repeats visibly. */
function pick<T>(list: T[]): T {
  const index = crypto.getRandomValues(new Uint32Array(1))[0]! % list.length;
  return list[index]!;
}

function twoDigits(): string {
  return String(10 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 90));
}

/**
 * One candidate. Three shapes, so a page of suggestions does not read as a template:
 * `sunnyotter`, `otter_river`, `willow42`.
 */
export function suggestOne(): string {
  const shape = crypto.getRandomValues(new Uint32Array(1))[0]! % 3;
  const candidate =
    shape === 0
      ? `${pick(ADJECTIVES)}${pick(NOUNS)}`
      : shape === 1
        ? `${pick(NOUNS)}_${pick(NOUNS)}`
        : `${pick(NOUNS)}${twoDigits()}`;
  // A 20-character ceiling can bite on the longest pairs; fall back rather than emit a name the
  // registry will refuse.
  return SHAPE.test(candidate) ? candidate : `${pick(NOUNS)}${twoDigits()}`;
}

/** `count` distinct candidates. Shape only — availability is the caller's next step. */
export function suggestMany(count: number): string[] {
  const out = new Set<string>();
  // Bounded: a duplicate-heavy draw must not spin. 40 draws for 3 names is generous.
  for (let i = 0; i < count * 12 && out.size < count; i++) out.add(suggestOne());
  return [...out];
}

/**
 * `count` suggestions that the registry says are FREE right now.
 *
 * A suggestion that turns out to be taken is worse than no suggestion — it is a tap that fails —
 * so each candidate is checked before it is offered. If the registry cannot be reached, unchecked
 * names are returned rather than an empty list: the claim button is still the real arbiter, and an
 * empty step is a dead end.
 */
export async function suggestAvailable(count = 3): Promise<{ names: string[]; checked: boolean }> {
  const candidates = suggestMany(count * 3);
  try {
    const results = await Promise.all(
      candidates.map(async (name) => {
        try {
          return (await checkHandle(name)).available ? name : null;
        } catch {
          return null;
        }
      }),
    );
    const free = results.filter((n): n is string => n !== null).slice(0, count);
    if (free.length > 0) return { names: free, checked: true };
  } catch {
    /* fall through to the unchecked list */
  }
  return { names: candidates.slice(0, count), checked: false };
}
