// Mixes the music bed with the nine voiceover lines, ducking the bed under each line.
// Marks are locked to the picture (beat-sheet.jpg): 1s of film = 1s of audio, no drift.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const BED = "../soundtrack.wav";
const OUT = "mixed.wav";
const DUR = 42;

// start seconds, file. Each line was written to land on a visual beat; see beat-sheet.jpg.
const LINES = [
  { t: 1.3, file: "assets/vo-01.mp3" },  // build: canvas rises, logo appears
  { t: 7.15, file: "assets/vo-02.mp3" }, // hero card "Give your agent a voice."
  { t: 9.6, file: "assets/vo-03.mp3" },  // what: "Text goes in."
  { t: 12.85, file: "assets/vo-10.mp3" }, // what: MP3 collage — the local engines
  { t: 15.6, file: "assets/vo-04.mp3" }, // fit: "Point your agent at it."
  { t: 19.3, file: "assets/vo-05.mp3" }, // how: "Key."
  { t: 22.8, file: "assets/vo-06.mp3" }, // how: client connects
  { t: 25.6, file: "assets/vo-07.mp3" }, // proof: no account, no bill
  { t: 34.6, file: "assets/vo-08.mp3" }, // end card: the claim
  { t: 38.6, file: "assets/vo-09.mp3" }, // end card: close
];

const BED_GAIN = 0.85; // -1.4 dB: leaves room for the voice without burying the track
const VO_GAIN = 1.6;   // ~+4 dB; the lines peak at -4.5 dBFS, so this still has headroom

const inputs = ["-i", BED, ...LINES.flatMap((l) => ["-i", l.file])];

// Normalise every voice input to 48k stereo and place it at its mark.
const vo = LINES.map((l, i) => {
  const ms = Math.round(l.t * 1000);
  return `[${i + 1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${VO_GAIN},adelay=${ms}|${ms}[v${i}]`;
});

const bus = LINES.map((_, i) => `[v${i}]`).join("") + `amix=inputs=${LINES.length}:normalize=0:dropout_transition=0`;
const graph = [
  ...vo,
  `${bus},asplit=2[vo][sc]`,
  // sidechaincompress stops when its shortest input ends, so pad the trigger to the full film
  `[sc]apad=whole_dur=${DUR}[scp]`,
  `[0:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${BED_GAIN},apad[bed]`,
  // sidechain compress the bed with the voice as the trigger: ~10 dB of duck while speaking
  `[bed][scp]sidechaincompress=threshold=0.02:ratio=8:attack=8:release=280:makeup=1,apad=whole_dur=${DUR}[duck]`,
  `[duck][vo]amix=inputs=2:normalize=0:dropout_transition=0,alimiter=limit=0.95:level=false[mix]`,
].join(";");

for (const l of LINES) if (!existsSync(l.file)) throw new Error(`missing ${l.file}`);

execFileSync("ffmpeg", [
  "-y", "-hide_banner", "-loglevel", "error",
  ...inputs,
  "-filter_complex", graph,
  "-map", "[mix]",
  "-t", String(DUR),
  "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le",
  OUT,
], { stdio: "inherit" });

console.log(`${OUT} — ${LINES.length} lines, bed ${BED_GAIN}x, voice ${VO_GAIN}x, ${DUR}s`);
