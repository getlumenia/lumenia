/**
 * Cut the recorded scenes into one silent MP4.
 *
 * Playwright writes VP8/WebM, one file per scene. This joins them with short cross-dissolves and
 * encodes H.264 so the file plays anywhere without a codec argument — QuickTime, Slack, a Keynote
 * slide, a grant reviewer's laptop.
 *
 * The dissolves matter more than they look. Hard cuts between ten browser recordings read as ten
 * separate clips someone stitched together; a quarter-second dissolve reads as one continuous
 * piece. Offsets are computed from each clip's real duration via ffprobe rather than assumed, so
 * re-recording a longer scene doesn't silently desync the rest.
 *
 * There is deliberately NO audio track at all (-an), not a silent one: a stray empty track is the
 * kind of thing that makes a player show a muted-speaker icon on a film that was never meant to
 * have sound.
 *
 * RUN: node e2e/demo/build.mjs
 * OUT: <repo root>/lumenia-demo.mp4   (gitignored)
 */
import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const RAW = path.resolve("e2e/demo/.raw");
const OUT = path.resolve("../../lumenia-demo.mp4"); // repo root
const XFADE = 0.35; // seconds of dissolve between scenes

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
  const files = (await readdir(RAW))
    .filter((f) => f.endsWith(".webm"))
    .sort()
    .map((f) => path.join(RAW, f));
  if (files.length === 0) throw new Error("no scenes in e2e/demo/.raw — run record.mjs first");

  const durations = [];
  for (const f of files) durations.push(await duration(f));
  const raw = durations.reduce((a, b) => a + b, 0);
  const final = raw - XFADE * (files.length - 1);
  console.log(`${files.length} scenes, ${raw.toFixed(1)}s of footage → ${final.toFixed(1)}s after dissolves`);

  // Normalise every input first: the browser writes a variable frame rate, and xfade needs a
  // constant one to line its offsets up.
  const filter = [];
  files.forEach((_, i) => filter.push(`[${i}:v]fps=30,format=yuv420p,setpts=PTS-STARTPTS[c${i}]`));

  let prev = "c0";
  let offset = durations[0] - XFADE;
  for (let i = 1; i < files.length; i++) {
    const out = i === files.length - 1 ? "vout" : `x${i}`;
    filter.push(`[${prev}][c${i}]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}[${out}]`);
    prev = out;
    offset += durations[i] - XFADE;
  }
  if (files.length === 1) filter.push("[c0]copy[vout]");

  const args = [
    "-y",
    ...files.flatMap((f) => ["-i", f]),
    "-filter_complex", filter.join(";"),
    "-map", "[vout]",
    "-an", // no audio track at all, not an empty one
    "-c:v", "libx264",
    "-preset", "slow",
    "-crf", "20",
    "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", // starts playing before it has fully downloaded
    OUT,
  ];
  console.log("encoding…");
  await run("ffmpeg", args, { maxBuffer: 1024 * 1024 * 64 });

  const { size } = await stat(OUT);
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,r_frame_rate",
    "-of", "default=noprint_wrappers=1",
    OUT,
  ]);
  console.log(`\n${OUT}`);
  console.log(`${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log(stdout.trim());
}

main().catch((e) => {
  console.error("build failed:", e.message);
  process.exit(1);
});
