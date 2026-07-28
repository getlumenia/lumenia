/**
 * Cut the recorded scenes to the voice, burn in the captions, and encode one MP4 for YouTube.
 *
 * Three things happen here, and the first is the one that matters.
 *
 * CONFORM. Every clip is forced into the window the narration gives it (timing.mjs). A clip that
 * ran long loses the difference from its FRONT, where the browser is sitting still after a page
 * load; a clip that came up short holds its last frame. Doing this in the edit rather than in the
 * shoot is what makes the sync survive a slow network on the day: the sponsor taking four extra
 * seconds to confirm a claim no longer pushes the rest of the film out from under the voice.
 *
 * DISSOLVE. Scenes cross-fade rather than cut. Ten browser recordings joined with hard cuts read
 * as ten clips somebody stitched together; a third of a second of dissolve reads as one piece.
 *
 * FINISH. Captions are burned in (captions.mjs), the voice is muxed, and the result is H.264 +
 * AAC with the moov atom at the front so it starts playing before it has finished downloading.
 * Without a voice recording present it still builds the silent cut, which is what the first pass
 * was.
 *
 * RUN: node e2e/demo/build.mjs
 * OUT: <repo root>/lumenia-demo.mp4   (gitignored)
 */
import { execFile } from "node:child_process";
import { readdir, stat, access } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { budgetFor, XFADE } from "./timing.mjs";

const run = promisify(execFile);
const RAW = path.resolve("e2e/demo/.raw");
const ROOT = path.resolve("../..");
const OUT = path.join(ROOT, "lumenia-demo.mp4");
const VOICE = path.join(ROOT, "lumenia-pitch-voice.opus");
const CAPTIONS = path.join(RAW, "captions.ass");

const exists = (f) => access(f).then(() => true).catch(() => false);

async function duration(file) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return Number.parseFloat(stdout.trim());
}

async function main() {
  const files = (await readdir(RAW)).filter((f) => f.endsWith(".webm")).sort();
  if (files.length === 0) throw new Error("no scenes in e2e/demo/.raw — run record.mjs first");

  const clips = [];
  for (const f of files) {
    const name = f.replace(/\.webm$/, "");
    const actual = await duration(path.join(RAW, f));
    const target = budgetFor(name) || actual;
    clips.push({ name, file: path.join(RAW, f), actual, target });
    const delta = actual - target;
    const how = Math.abs(delta) < 0.05 ? "exact" : delta > 0 ? `trim ${delta.toFixed(1)}s off the front` : `hold ${(-delta).toFixed(1)}s`;
    console.log(`  ${name.padEnd(16)} ${actual.toFixed(1)}s → ${target.toFixed(1)}s  (${how})`);
  }
  const total = clips.reduce((a, c) => a + c.target, 0) - XFADE * (clips.length - 1);
  console.log(`\n${clips.length} scenes → ${total.toFixed(1)}s`);

  /**
   * Conform each clip to its window, in the order that costs the least.
   *
   * 1. Trim from the FRONT, but only a couple of seconds. That head is the browser sitting still
   *    after a page load, so it is the one part of a scene nobody misses. Trimming further starts
   *    eating the action — cutting into somebody typing an amount, or into the sentence that warns
   *    about the wrong network.
   * 2. Speed up whatever is left over, capped. Most of the remaining excess is a network wait: a
   *    button reading "Making your link…" while the ledger confirms. A screencast at 1.3x still
   *    looks like a person using software; past about 1.4x it starts to look like a fast-forward,
   *    so that is where it stops and says so instead of quietly ruining the shot.
   * 3. Hold the last frame when a clip came up short. tpad clones the final frame rather than
   *    inventing one, so the shot is simply still.
   */
  const MAX_FRONT_TRIM = 2.5;
  const MAX_SPEED = 1.4;
  const filter = [];
  clips.forEach((c, i) => {
    const steps = ["fps=30"];
    const excess = c.actual - c.target;
    if (excess > 0.02) {
      const trim = Math.min(excess, MAX_FRONT_TRIM);
      if (trim > 0.02) steps.push(`trim=start=${trim.toFixed(3)}`, "setpts=PTS-STARTPTS");
      const left = c.actual - trim;
      if (left - c.target > 0.02) {
        const speed = left / c.target;
        if (speed > MAX_SPEED) {
          console.log(`  ! ${c.name} needs ${speed.toFixed(2)}x — above the ${MAX_SPEED}x cap; it will run long`);
        }
        steps.push(`setpts=PTS/${Math.min(speed, MAX_SPEED).toFixed(4)}`);
      }
    } else if (-excess > 0.02) {
      steps.push(`tpad=stop_mode=clone:stop_duration=${(-excess).toFixed(3)}`);
    }
    steps.push("format=yuv420p", "setpts=PTS-STARTPTS");
    filter.push(`[${i}:v]${steps.join(",")}[c${i}]`);
  });

  let prev = "c0";
  let offset = clips[0].target - XFADE;
  for (let i = 1; i < clips.length; i++) {
    const out = i === clips.length - 1 ? "vout" : `x${i}`;
    filter.push(`[${prev}][c${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${out}]`);
    prev = out;
    offset += clips[i].target - XFADE;
  }
  if (clips.length === 1) filter.push("[c0]copy[vout]");

  // Captions last, so they are laid over the finished cut and never scaled or dissolved with it.
  const hasCaptions = await exists(CAPTIONS);
  if (hasCaptions) {
    filter.push(`[vout]subtitles=${CAPTIONS.replace(/:/g, "\\:")}:fontsdir=/System/Library/Fonts[vsub]`);
  }
  const vlabel = hasCaptions ? "vsub" : "vout";

  const hasVoice = await exists(VOICE);
  const args = [
    "-y",
    ...clips.flatMap((c) => ["-i", c.file]),
    ...(hasVoice ? ["-i", VOICE] : []),
    "-filter_complex", filter.join(";"),
    "-map", `[${vlabel}]`,
    ...(hasVoice ? ["-map", `${clips.length}:a`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : ["-an"]),
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "19",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    ...(hasVoice ? ["-shortest"] : []),
    OUT,
  ];
  console.log(`encoding${hasCaptions ? " with captions" : ""}${hasVoice ? " and voice" : " (silent)"}…`);
  await run("ffmpeg", args, { maxBuffer: 1024 * 1024 * 64 });

  const { size } = await stat(OUT);
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate",
    "-of", "default=noprint_wrappers=1",
    OUT,
  ]);
  console.log(`\n${OUT}\n${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(stdout.trim());
}

main().catch((e) => {
  console.error("build failed:", e.message);
  process.exit(1);
});
