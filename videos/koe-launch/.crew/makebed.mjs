// Placeholder 120 BPM bed: kick on every beat, clap on 2 and 4, hats on the offbeat 8ths,
// a pentatonic marimba line and a bass root. It exists so soundtrack.mjs can detect a real
// beat grid and so the cut can be reviewed; replace assets/music.mp3 with a licensed track
// before delivery.
import fs from "node:fs";

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5 s
const BARS = 48;
const DUR = BARS * 4 * BEAT; // 96 s
const N = Math.floor(DUR * SR);
const mix = new Float32Array(N);

const add = (t0, dur, fn, gain = 1) => {
  const start = Math.floor(t0 * SR);
  const len = Math.floor(dur * SR);
  for (let i = 0; i < len; i++) {
    const idx = start + i;
    if (idx < 0 || idx >= N) continue;
    mix[idx] += fn(i / SR) * gain;
  }
};

const kick = (t) =>
  add(t, 0.3, (s) => {
    const f = 120 * Math.exp(-s * 28) + 48;
    return Math.sin(2 * Math.PI * f * s) * Math.exp(-s * 14);
  }, 0.85);

const clap = (t) =>
  add(t, 0.18, (s) => (Math.random() * 2 - 1) * Math.exp(-s * 45), 0.28);

const hat = (t) =>
  add(t, 0.06, (s) => {
    const n = Math.random() * 2 - 1;
    return n * Math.exp(-s * 120);
  }, 0.10);

const marimba = (t, freq) =>
  add(t, 0.45, (s) => {
    const env = Math.exp(-s * 9);
    return (Math.sin(2 * Math.PI * freq * s) * 0.7 + Math.sin(4 * Math.PI * freq * s) * 0.3) * env;
  }, 0.16);

const bass = (t, freq) =>
  add(t, 0.6, (s) => Math.sin(2 * Math.PI * freq * s) * Math.exp(-s * 4), 0.22);

// F minor pentatonic-ish, keeps it warm rather than chirpy.
const scale = [349.23, 392.0, 466.16, 523.25, 587.33, 698.46];
const pattern = [0, 2, 4, 3, 5, 4, 2, 1];

for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * 4 * BEAT;
  for (let b = 0; b < 4; b++) {
    const t = t0 + b * BEAT;
    kick(t);
    if (b === 1 || b === 3) clap(t);
    hat(t + BEAT / 2);
    bass(t, b % 2 === 0 ? 87.31 : 116.54);
    marimba(t + BEAT / 2, scale[pattern[(bar * 4 + b) % pattern.length]]);
  }
}

// Peak-normalise to about -3 dBFS, then write 16-bit stereo.
let peak = 0;
for (const v of mix) peak = Math.max(peak, Math.abs(v));
const norm = peak > 0 ? 0.7 / peak : 1;

const data = Buffer.alloc(N * 4);
for (let i = 0; i < N; i++) {
  const v = Math.max(-1, Math.min(1, mix[i] * norm));
  const s = Math.round(v * 32767);
  data.writeInt16LE(s, i * 4);
  data.writeInt16LE(s, i * 4 + 2);
}

const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVE", 8);
header.write("fmt ", 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(2, 22);
header.writeUInt32LE(SR, 24);
header.writeUInt32LE(SR * 4, 28);
header.writeUInt16LE(4, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);

fs.mkdirSync("assets", { recursive: true });
fs.writeFileSync("assets/bed.wav", Buffer.concat([header, data]));
console.log("assets/bed.wav", DUR.toFixed(1) + "s", BPM + " BPM");
