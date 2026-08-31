// Motion primitives: frame-rate independence, stability, and beat shaping.
// Run: node scripts/test-motion.js
"use strict";

const fs = require("node:fs");
const path = require("node:path");
new Function(fs.readFileSync(path.join(__dirname, "../src/motion.js"), "utf8")).call(globalThis);
const { Spring, Envelope, swell, archShape } = globalThis.ScvizMotion;

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

// --- springs are frame-rate independent -----------------------------------
{
  // Integrate to the SAME total time at every rate, sampled mid-flight while
  // the spring is still moving. Stepping a fixed count of 1/fps frames would
  // compare different instants and measure nothing.
  const T = 0.1;
  const settle = (fps) => {
    const s = new Spring(4, 0.6);
    s.impulse(10);
    const n = Math.max(1, Math.round(fps * T));
    for (let i = 0; i < n; i++) s.update(T / n);
    return s.x;
  };
  const at60 = settle(60);
  const rates = [15, 30, 90, 144];
  let worst = 0;
  for (const r of rates) worst = Math.max(worst, Math.abs(settle(r) - at60));
  check("spring lands the same at 15-144 fps", Math.abs(at60) > 0.05 && worst < 1e-6,
        `max deviation ${worst.toExponential(2)} from ${at60.toFixed(4)}`);
}

// --- and stable when a frame is enormous ----------------------------------
{
  const s = new Spring(8, 0.5);
  s.impulse(5);
  for (let i = 0; i < 30; i++) s.update(0.5); // half-second frames
  check("spring survives half-second frames", Number.isFinite(s.x) && Math.abs(s.x) < 5,
        `x ${s.x.toExponential(2)}`);
}

// --- follow-through: underdamped overshoots, critical does not ------------
{
  const run = (damping) => {
    const s = new Spring(4, damping);
    s.impulse(6);
    let peak = 0;
    let minAfterPeak = 0;
    let seenPeak = false;
    for (let i = 0; i < 240; i++) {
      s.update(1 / 120);
      if (!seenPeak && s.x > peak) peak = s.x;
      else if (peak > 0) { seenPeak = true; minAfterPeak = Math.min(minAfterPeak, s.x); }
    }
    return { peak, minAfterPeak };
  };
  const soft = run(0.45);
  const crit = run(1.0);
  check("underdamped spring overshoots past rest", soft.minAfterPeak < -0.02,
        `undershoot ${soft.minAfterPeak.toFixed(3)}`);
  check("critically damped spring does not ring", crit.minAfterPeak > -0.02,
        `undershoot ${crit.minAfterPeak.toFixed(4)}`);
}

// --- anticipation ramp ----------------------------------------------------
{
  check("swell is flat away from the beat", swell(0.1) === 0 && swell(0.5) === 0);
  check("swell rises into the beat", swell(0.95) > swell(0.8) && swell(0.8) > swell(0.75),
        `.75 ${swell(0.75).toFixed(3)} .8 ${swell(0.8).toFixed(3)} .95 ${swell(0.95).toFixed(3)}`);
  check("swell reaches full height at the beat", swell(0.9999) > 0.999, swell(0.9999).toFixed(5));

  // Must be monotonic across the whole window, or the approach stutters.
  let monotonic = true;
  let prev = -1;
  for (let p = 0.6; p < 0.9999; p += 0.001) {
    const v = swell(p);
    if (v < prev - 1e-9) monotonic = false;
    prev = v;
  }
  check("anticipation ramp is monotonic", monotonic);

}

// --- the hit must survive a slow frame rate -------------------------------
{
  // A triggered envelope, decayed BEFORE the trigger, always presents its full
  // peak on the frame the beat lands. This is the guarantee that lets a 30 fps
  // machine hit as hard as a 144 fps one.
  const peakOf = (fps, decayFirst) => {
    const e = new Envelope(0.005, 0.16);
    const dt = 1 / fps;
    let t = 0;
    let prev = 0;
    let max = 0;
    for (let i = 0; i < fps * 4; i++) {
      t += dt;
      const phase = (t / 0.5) % 1;
      const beat = phase < prev;
      prev = phase;
      if (decayFirst) e.decay(dt);
      if (beat) e.trigger(1);
      if (!decayFirst) e.decay(dt);
      max = Math.max(max, e.value);
    }
    return max;
  };
  const good = Math.abs(peakOf(30, true) - peakOf(144, true));
  check("triggered hit reaches full height at any frame rate", good < 1e-6,
        `30fps ${peakOf(30, true).toFixed(4)} vs 144fps ${peakOf(144, true).toFixed(4)}`);
  // Decaying after the trigger loses part of the peak on slow frames, which is
  // why the order matters and is asserted rather than assumed.
  check("decaying after the trigger loses the peak on slow frames",
        Math.abs(peakOf(30, false) - peakOf(144, false)) > 0.05,
        `30fps ${peakOf(30, false).toFixed(3)} vs 144fps ${peakOf(144, false).toFixed(3)}`);
}

// --- arch shape spans the bar ---------------------------------------------
{
  check("arch builds across the phrase", archShape(0.9) > archShape(0.5) && archShape(0.5) > archShape(0.1));
  check("arch resets at the boundary", archShape(1.0) === 0);
}

// --- envelopes are frame-rate independent and asymmetric ------------------
{
  const drive = (fps, seconds, target) => {
    const e = new Envelope(0.01, 0.3);
    const dt = 1 / fps;
    for (let i = 0; i < fps * seconds; i++) e.push(target, dt);
    return e.value;
  };
  const d = Math.abs(drive(30, 0.5, 1) - drive(120, 0.5, 1));
  check("envelope converges the same at 30 and 120 fps", d < 0.01, `delta ${d.toFixed(5)}`);

  const e = new Envelope(0.01, 0.3);
  for (let i = 0; i < 6; i++) e.push(1, 1 / 60);   // 100 ms rising
  const up = e.value;
  for (let i = 0; i < 6; i++) e.push(0, 1 / 60);   // 100 ms falling
  check("envelope attacks faster than it releases", up > 0.95 && e.value > 0.6,
        `up ${up.toFixed(3)} then ${e.value.toFixed(3)}`);
}

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
