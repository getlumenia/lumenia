/**
 * Where the narration moves on, in seconds. The single source of truth for the film's timing.
 *
 * The first cut was recorded silent and the voice was recorded to the script, so the two drifted
 * apart: by the middle of the film the words were describing the account screen while the picture
 * was still finishing a claim. Retiming afterwards was not an option, because the stretch factors
 * came out between 0.22x and 2.4x, which is visibly broken.
 *
 * So the picture is cut to the voice. Every number here is the moment the narration stops talking
 * about one thing and starts on the next, measured by force-aligning the script against the actual
 * recording — the same alignment captions.mjs uses, so captions and cuts can never disagree.
 *
 * record.mjs uses these as time budgets while shooting. build.mjs then conforms each clip to its
 * window exactly, so a slow network on the day cannot push the whole film out of sync.
 */
export const ENDS_AT = {
  "01-landing": 20.6,
  "02-claim": 44.0,
  "03-home": 49.7,
  "04-send": 65.8,
  "05-locked-claim": 88.7,
  "06-account": 119.4,
  "07-add-money": 132.8,
  "08-send-out": 147.9,
  "09-cash-out": 156.2,
  "10-trust": 172.4,
};

/** Seconds of cross-dissolve between scenes, so each clip is recorded and cut slightly long. */
export const XFADE = 0.35;

/** The window a scene owns, including its overlap into the next one. */
export function budgetFor(name) {
  const names = Object.keys(ENDS_AT);
  const i = names.indexOf(name);
  if (i < 0) return 0;
  const start = i === 0 ? 0 : ENDS_AT[names[i - 1]];
  const isLast = i === names.length - 1;
  return ENDS_AT[name] - start + (isLast ? 0 : XFADE);
}
