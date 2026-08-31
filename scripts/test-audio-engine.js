// Validates the real-input FFT against a naive DFT and benchmarks the hot path.
// Run: node scripts/test-audio-engine.js
"use strict";

const path = require("node:path");
const fs = require("node:fs");

const g = { performance: { now: () => Number(process.hrtime.bigint()) / 1e6 } };
globalThis.performance ||= g.performance;
const src = fs.readFileSync(path.join(__dirname, "../src/audio-engine.js"), "utf8");
new Function(src).call(globalThis);
const { RealFFT, Features, dbNorm } = globalThis.ScvizAudio;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

function naiveMag(x, n) {
  const out = new Float64Array(n / 2 + 1);
  for (let k = 0; k <= n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * k * i) / n;
      re += x[i] * Math.cos(a);
      im += x[i] * Math.sin(a);
    }
    out[k] = Math.hypot(re, im);
  }
  return out;
}

// --- correctness -----------------------------------------------------------
for (const n of [512, 1024, 2048]) {
  const fft = new RealFFT(n);
  const ring = new Float32Array(n * 2);
  const win = new Float32Array(n).fill(1); // rectangular, so we compare raw DFT
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] =
      Math.sin((2 * Math.PI * 5.5 * i) / n) * 0.7 +
      Math.sin((2 * Math.PI * 61 * i) / n + 1.1) * 0.3 +
      (((i * 2654435761) >>> 0) / 4294967296 - 0.5) * 0.05;
  }
  // Place the frame at a non-zero, wrapping offset to exercise ring indexing.
  const start = ring.length - (n >> 1);
  for (let i = 0; i < n; i++) ring[(start + i) & (ring.length - 1)] = x[i];

  const out = new Float32Array(n / 2 + 1);
  fft.magnitudes(ring, start, win, out, 1);
  const ref = naiveMag(x, n);

  let maxErr = 0;
  let scale = 0;
  for (let k = 0; k <= n / 2; k++) scale = Math.max(scale, ref[k]);
  for (let k = 0; k <= n / 2; k++) maxErr = Math.max(maxErr, Math.abs(out[k] - ref[k]));
  check(`RealFFT n=${n} matches naive DFT`, maxErr / scale < 1e-5, `relerr ${(maxErr / scale).toExponential(2)}`);
}

// A full-scale sine must land at 0.25 with |X|/n scaling (Hann coherent gain
// 0.5), which is what the -90..-22 dB window was tuned against.
{
  const n = 2048;
  const fft = new RealFFT(n);
  const ring = new Float32Array(n * 2);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  for (let i = 0; i < n; i++) ring[i] = Math.sin((2 * Math.PI * 64 * i) / n);
  const out = new Float32Array(n / 2 + 1);
  fft.magnitudes(ring, 0, win, out, 1 / n);
  let peak = 0;
  for (let k = 0; k <= n / 2; k++) peak = Math.max(peak, out[k]);
  check("full-scale sine scales to ~0.25", Math.abs(peak - 0.25) < 0.005, `peak ${peak.toFixed(4)}`);
  check("0 dBFS maps below the soft knee ceiling", dbNorm(peak) > 0.85 && dbNorm(peak) < 1.3, `dbNorm ${dbNorm(peak).toFixed(3)}`);
}

// --- soft knee -------------------------------------------------------------
{
  const loud = dbNorm(10);   // way past full scale
  const hot = dbNorm(0.25);  // 0 dBFS sine
  check("soft knee stays monotonic past full scale", loud > hot, `${hot.toFixed(3)} -> ${loud.toFixed(3)}`);
  check("soft knee is bounded", loud < 1.35, `${loud.toFixed(3)}`);
  check("silence maps to 0", dbNorm(0) === 0);
}

// --- envelopes are frame-rate independent ----------------------------------
{
  const layout = globalThis.ScvizAudio.defaultLayout;
  const run = (dt, steps) => {
    const f = new Features(layout);
    const b = new Float32Array(256).fill(0.5);
    for (let i = 0; i < steps; i++) f.update(b, dt);
    return f;
  };
  const a = run(1 / 86, 86 * 3);   // analysis clock
  const c = run(1 / 30, 30 * 3);   // a machine dropping to 30 fps
  const d = Math.abs(a.loudness - c.loudness);
  check("loudness converges the same at 86 Hz and 30 Hz", d < 0.02, `delta ${d.toFixed(4)}`);
  const db = Math.abs(a.smoothBass - c.smoothBass);
  check("smoothBass converges the same at 86 Hz and 30 Hz", db < 0.02, `delta ${db.toFixed(4)}`);
}

// kick decay must be wall-clock, not per-frame
{
  const layout = globalThis.ScvizAudio.defaultLayout;
  const decay = (dt, seconds) => {
    const f = new Features(layout);
    f.kick = 1;
    const quiet = new Float32Array(256);
    for (let i = 0; i < Math.round(seconds / dt); i++) {
      f.update(quiet, dt);
      f.kick = Math.min(f.kick, i === 0 ? 1 : f.kick);
    }
    return f.kick;
  };
  const fast = decay(1 / 86, 0.5);
  const slow = decay(1 / 30, 0.5);
  check("kick decays at the same wall-clock rate", Math.abs(fast - slow) < 0.01, `${fast.toFixed(4)} vs ${slow.toFixed(4)}`);
}

// --- cost ------------------------------------------------------------------
{
  const sr = 44100;
  const n = 2048;
  const hop = 512;
  const fft = new RealFFT(n);
  const ring = new Float32Array(8192);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  for (let i = 0; i < ring.length; i++) ring[i] = Math.sin(i * 0.07) * 0.4 + Math.sin(i * 0.31) * 0.2;
  const mag = new Float32Array(n / 2 + 1);
  const bands = new Float32Array(256);
  const feats = new Features(globalThis.ScvizAudio.defaultLayout);

  const iters = 4000;
  for (let i = 0; i < 500; i++) fft.magnitudes(ring, 0, win, mag, 1 / n); // warm
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    fft.magnitudes(ring, (i * hop) & (ring.length - 1), win, mag, 1 / n);
    for (let j = 0; j < 256; j++) bands[j] = dbNorm(mag[(j * 2) + 2]);
    feats.update(bands, hop / sr);
  }
  const per = (performance.now() - t0) / iters;
  const cpu = (per * (sr / hop)) / 10; // % of one core
  console.log(`\n  hot path: ${per.toFixed(3)} ms/hop, ${(sr / hop).toFixed(1)} hops/s -> ${cpu.toFixed(2)}% of one core`);
  check("hot path under 0.5 ms/hop", per < 0.5, `${per.toFixed(3)} ms`);
}

// --- the page bridge must forward the whole frame -------------------------
// The extension's default path taps SoundCloud's own AudioContext in the MAIN
// world and postMessages frames to the page. That forwarding was written as a
// hand-listed set of fields before the onset layer and beat clock existed, and
// was never updated -- so on real SoundCloud the visualiser got levels and a
// spectrum but no onsets, no tempo and no beat phase, and silently degraded to
// reactive-only. Nothing failed; it just quietly did less.
{
  const engineSrc = fs.readFileSync(path.join(__dirname, "../src/audio-engine.js"), "utf8");
  const m = engineSrc.match(/this\.frameOut = \{([\s\S]*?)\n      \};/);
  const emitted = m ? [...m[1].matchAll(/^\s{8}([A-Za-z_]\w*):/gm)].map((x) => x[1]) : [];
  check("engine frame shape is discoverable", emitted.length > 20, `${emitted.length} fields`);

  const required = [
    "odf", "thresh", "onset", "hit", "surprise", "since",
    "bpm", "confidence", "downbeatConfidence", "locked",
    "beatPhase", "barPhase", "phrasePhase", "timeToNextBeat", "beat", "downbeat",
    "rawSmoothBass",
  ];
  const missing = required.filter((k) => !emitted.includes(k));
  check("engine emits the onset and beat-clock fields", missing.length === 0, missing.join(", "));

  const bridge = fs.readFileSync(path.join(__dirname, "../src/page-bridge.js"), "utf8");
  const body = bridge.slice(bridge.indexOf("function emitFrame"), bridge.indexOf("post(frameMsg)"));
  const handListed = [...body.matchAll(/frameMsg\.([A-Za-z_]\w*)\s*=/g)].map((x) => x[1]);
  check("page bridge forwards generically, not by a hand list", handListed.length === 0,
        handListed.length ? `hand-lists ${handListed.length} fields` : "for..in copy");

  // And prove the copy actually survives a structured clone, which is what
  // postMessage does.
  const frame = {};
  for (const k of emitted) frame[k] = k === "odf" ? { low: 1, mid: 2, high: 3 } : 1;
  frame.bands = new Float32Array(4);
  frame.freq = new Uint8Array(4);
  const msg = {};
  for (const key in frame) { if (key === "bands") continue; msg[key] = frame[key]; }
  const arrived = structuredClone(msg);
  const lost = emitted.filter((k) => k !== "bands" && !(k in arrived));
  check("every emitted field survives the post", lost.length === 0, lost.join(", "));
  check("the analysis-only spectrum is not shipped", !("bands" in arrived));
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
