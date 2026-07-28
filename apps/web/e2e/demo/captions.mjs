/**
 * Build burned-in captions for the demo film, timed against the real voice recording.
 *
 * The timings are not guessed and not spread evenly. Whisper transcribes the recording with
 * word-level timestamps, and the SCRIPT — which is the ground truth, since it is what was read —
 * is force-aligned onto those timestamps. Whisper mishears plenty (it wrote "Izmish" for Izmir),
 * so its words are used only as clocks; every character on screen comes from the script file.
 * Roughly nine in ten script words match a transcribed word directly; the rest are interpolated
 * between their neighbours, which is accurate to a fraction of a second at this speaking rate.
 *
 * Styling: white text, no box behind it, a soft shadow, and a short fade in — as asked.
 * One deviation, and it is the difference between readable and not: the film's background is warm
 * off-white paper, and plain white text on near-white is invisible. So the "shadow" is a blurred
 * dark halo tight around the glyphs (ASS outline + \blur) rather than a hard offset. It is still
 * white text with a shadow and no background; it is just a shadow that actually carries the text.
 *
 * RUN: node e2e/demo/captions.mjs   (after transcribing the voice; see TRANSCRIBE below)
 *
 * TRANSCRIBE:
 *   whisper lumenia-pitch-voice.opus --model small.en --language en \
 *     --word_timestamps True --output_format json --output_dir <dir>
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve("../..");
const SCRIPT = path.join(ROOT, "lumenia-demo-script.txt");
const OUT = path.resolve("e2e/demo/.raw/captions.ass");
const TRANSCRIPT = process.env.TRANSCRIPT ?? path.join(ROOT, "lumenia-pitch-voice.json");

/** Frame size, so the caption sits where it was designed to sit rather than being scaled. */
const W = 1440;
const H = 900;
/**
 * MarginV is 76, not the 52 a caption would normally sit at. YouTube's player controls slide over
 * the bottom of the frame on hover, and a caption tucked into the last 6% spends half the film
 * behind a scrub bar. This clears them.
 */
/** Two lines at most, and this many characters per line before wrapping. */
const LINE = 46;
const MAX_LINES = 2;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Longest-common-subsequence alignment between the transcript and the script.
 *
 * A plain index-for-index mapping drifts the moment the transcriber inserts or drops a word, and it
 * dropped 22 of them here. Matching on the LCS anchors every word it heard correctly and leaves the
 * rest to be interpolated, so a mishearing costs a fraction of a second instead of shifting
 * everything after it.
 */
function alignTimes(heard, script) {
  const a = heard.map((w) => norm(w.word));
  const b = script.map(norm);
  const n = a.length;
  const m = b.length;
  // LCS table, then walk it back to pairs.
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const times = new Array(m).fill(null);
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      times[j] = { start: heard[i].start, end: heard[i].end };
      matched++;
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }

  // Interpolate the gaps: unmatched script words share the span between their nearest anchors.
  const lastEnd = heard[heard.length - 1].end;
  for (let k = 0; k < m; k++) {
    if (times[k]) continue;
    let prev = k - 1;
    while (prev >= 0 && !times[prev]) prev--;
    let next = k + 1;
    while (next < m && !times[next]) next++;
    const from = prev >= 0 ? times[prev].end : 0;
    const to = next < m ? times[next].start : lastEnd;
    const gap = next < m ? next : m;
    const span = (to - from) / Math.max(1, gap - (prev + 1) + 1);
    const offset = k - (prev + 1);
    times[k] = { start: from + span * offset, end: from + span * (offset + 1) };
  }
  return { times, matched };
}

/** Wrap a cue to at most MAX_LINES lines, balancing them so one isn't a stub. */
function wrap(text) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > LINE) {
      lines.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines.slice(0, MAX_LINES).join("\\N") + (lines.length > MAX_LINES ? " " + lines.slice(MAX_LINES).join(" ") : "");
}

/**
 * Cut the script into caption-sized pieces at sentence ends, then at clause commas when a sentence
 * is too long to sit on two lines. Captions that break mid-clause are the ones people find hard to
 * read, so the split follows the writing rather than a character count.
 */
function toCues(scriptText) {
  const cues = [];
  for (const para of scriptText.trim().split(/\n{2,}/)) {
    const sentences = para.trim().replace(/\s+/g, " ").match(/[^.?!]+[.?!]+|\S+$/g) ?? [];
    let buf = "";
    const flush = () => {
      if (buf.trim()) cues.push(buf.trim());
      buf = "";
    };
    for (const sRaw of sentences) {
      const s = sRaw.trim();
      if ((buf + " " + s).trim().length <= LINE * MAX_LINES) {
        buf = (buf ? buf + " " : "") + s;
        continue;
      }
      flush();
      if (s.length <= LINE * MAX_LINES) {
        buf = s;
        continue;
      }
      // Still too long: break at commas, keeping each piece a whole clause.
      let piece = "";
      for (const clause of s.split(/(?<=,)\s+/)) {
        if ((piece + " " + clause).trim().length > LINE * MAX_LINES) {
          if (piece) cues.push(piece.trim());
          piece = clause;
        } else piece = (piece ? piece + " " : "") + clause;
      }
      if (piece.trim()) cues.push(piece.trim());
    }
    flush();
  }
  return cues;
}

const ts = (sec) => {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${ss.toFixed(2).padStart(5, "0")}`;
};

async function main() {
  const scriptText = await readFile(SCRIPT, "utf8");
  const transcript = JSON.parse(await readFile(TRANSCRIPT, "utf8"));
  const heard = transcript.segments.flatMap((s) => s.words ?? []);
  if (heard.length === 0) throw new Error("the transcript has no word timings — re-run whisper with --word_timestamps True");

  const scriptWords = scriptText.trim().split(/\s+/);
  const { times, matched } = alignTimes(heard, scriptWords);
  console.log(`aligned ${matched}/${scriptWords.length} words (${((matched / scriptWords.length) * 100).toFixed(0)}%) against ${heard.length} transcribed`);

  // Walk the cues back over the same word list so each one inherits its own words' timings.
  const cues = toCues(scriptText);
  let w = 0;
  const timed = cues.map((cue) => {
    const count = cue.split(/\s+/).length;
    const start = times[w].start;
    const end = times[Math.min(times.length - 1, w + count - 1)].end;
    w += count;
    return { cue, start, end };
  });
  if (w !== scriptWords.length) throw new Error(`cue words (${w}) != script words (${scriptWords.length}) — the splitter dropped something`);

  // Hold each caption until the next one starts, so the screen is never briefly blank between two
  // sentences of one breath. Clamped so a long pause doesn't leave a stale line hanging.
  const lines = timed.map(({ cue, start, end }, i) => {
    const next = timed[i + 1]?.start ?? end + 0.6;
    const out = Math.min(next - 0.04, end + 0.9);
    return `Dialogue: 0,${ts(start - 0.12)},${ts(Math.max(out, start + 0.7))},Caption,,0,0,0,,{\\blur2.6\\fad(220,140)}${wrap(cue)}`;
  });

  const ass = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Helvetica Neue,33,&H00FFFFFF,&H00FFFFFF,&HA0101014,&H78000000,0,0,0,0,100,100,0.2,0,1,2,1.2,2,110,110,76,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join("\n")}
`;
  await writeFile(OUT, ass, "utf8");
  console.log(`${timed.length} captions → ${OUT}`);
  console.log(`last caption ends at ${ts(timed[timed.length - 1].end)}`);
}

main().catch((e) => {
  console.error("captions failed:", e.message);
  process.exit(1);
});
