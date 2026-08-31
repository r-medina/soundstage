// Motion-layer check (P3). Evaluated against a loaded preview.html, where the
// real visualizer already exists:
//
//   node <cdp-driver> http://127.0.0.1:8791/preview.html "$(cat scripts/motion-check.js)"
//
// Drives the real visualizer with a synthetic locked beat clock and asserts the
// properties P3 is supposed to deliver: the motion anticipates the beat rather
// than chasing it, behaves identically at 30 and 90 fps, degrades to reactive
// envelopes when the clock is not confident, and never puts a level into a
// velocity. Rendering is bypassed because this measures motion, not pixels.
(() => {
  // Drive the real visualizer with a synthetic locked beat clock. Rendering is
  // bypassed (renderer = null) because this measures motion, not pixels.
  viz.stop();
  viz.setMode("pulse");
  const savedRenderer = viz.renderer;
  viz.renderer = null;

  const BPM = 120;
  const PERIOD = 60 / BPM;

  const run = (fps, seconds, confidence, bassWobble, loudFn, pauseAt) => {
    // Fresh motion state per run.
    viz._springs = null;
    viz._prevBeatPhase = undefined;
    viz._prevShifted = undefined;
    viz._pulseSpin = 0;
    viz.motion.beatAmp = 0.5;
    viz._loudMax = undefined;
    viz._loudMin = undefined;
    viz.beatPhase = 0;
    const dt = 1 / fps;
    const samples = [];
    let t = 0;
    let prevPhase = 0;
    for (let i = 0; i < fps * seconds; i++) {
      t += dt;
      const phase = (t / PERIOD) % 1;
      const beat = phase < prevPhase;
      prevPhase = phase;
      const wob = bassWobble ? 0.5 + 0.45 * Math.sin(t * 37.0) : 0.5;
      // After pauseAt the transport has stopped: silence in, no onsets, and
      // the clock reports that it is no longer locked.
      const paused = pauseAt !== undefined && t >= pauseAt;
      viz.setFrame(paused ? {
        freq: viz.freq, time: viz.time,
        bass: 0, mid: 0, high: 0, smoothBass: 0,
        loudness: 0, energy: 0, integratedPower: 0, gain: 1, peak: 0, flux: 0, kick: 0,
        odf: { low: 0, mid: 0, high: 0, broadband: 0 },
        thresh: { low: 0, mid: 0, high: 0 },
        onset: { low: 0, mid: 0, high: 0 },
        hit: { low: 0, mid: 0, high: 0 },
        surprise: { low: 0, mid: 0, high: 0 },
        since: { low: (t - pauseAt) * 1000, mid: 1e6, high: 1e6 },
        bpm: BPM, confidence: 0, downbeatConfidence: 0, locked: false,
        beatPhase: phase, barPhase: 0, phrasePhase: 0,
        beatIndex: 0, barIndex: 0, timeToNextBeat: 0,
        beat: false, downbeat: false, concentration: 0, acfPeak: 0,
      } : {
        freq: viz.freq, time: viz.time,
        bass: wob, mid: 0.3, high: 0.2, smoothBass: wob,
        loudness: loudFn ? loudFn(t) : 0.5, energy: 0.5, integratedPower: 0.4,
        gain: 1, peak: 0.5, flux: 0.02, kick: beat ? 0.9 : 0,
        odf: { low: 0, mid: 0, high: 0, broadband: 0 },
        thresh: { low: 0, mid: 0, high: 0 },
        onset: { low: beat ? 0.9 : 0.1, mid: 0, high: 0 },
        hit: { low: beat ? 0.9 : 0, mid: 0, high: 0 },
        surprise: { low: 1, mid: 0, high: 0 },
        since: { low: 0, mid: 1e6, high: 1e6 },
        bpm: BPM, confidence, downbeatConfidence: 0.8, locked: true,
        beatPhase: phase, barPhase: (t / (PERIOD * 4)) % 1,
        phrasePhase: (t / (PERIOD * 32)) % 1,
        beatIndex: Math.floor(t / PERIOD), barIndex: 0,
        timeToNextBeat: (1 - phase) * PERIOD,
        beat, downbeat: false, concentration: 0.5, acfPeak: 0.5,
      });
      viz._tick(dt);
      samples.push({
        t, phase,
        accent: viz.motion.accent,
        gridMix: viz.motion.gridMix,
        scale: viz.pulse.scale.x,
        rotY: viz.pulse.rotation.y,
        loud: viz.motion.loudness,
        antic: viz.motion.anticipation,
        live: viz.motion.live,
      });
    }
    return samples;
  };

  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });

  // --- anticipation ------------------------------------------------------
  const locked = run(60, 10, 1.0, false);
  const settled = locked.filter((s) => s.t > 6);
  const inBand = (lo, hi) => {
    const v = settled.filter((s) => s.phase >= lo && s.phase < hi).map((s) => s.accent);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
  };
  const approach = inBand(0.85, 0.99);
  const mid = inBand(0.45, 0.6);
  const onBeat = inBand(0.0, 0.06);
  add("grid engages at high confidence", settled[settled.length - 1].gridMix > 0.9,
      `gridMix ${settled[settled.length - 1].gridMix.toFixed(3)}`);
  add("accent rises before the beat", approach > mid * 1.8,
      `phase .85-.99 ${approach.toFixed(3)} vs .45-.6 ${mid.toFixed(3)}`);
  add("accent peaks on the beat", onBeat > approach,
      `on-beat ${onBeat.toFixed(3)} > approach ${approach.toFixed(3)}`);

  // Scale follows loudness, not kick/snare onsets. A constant-loudness
  // passage with beats firing must not jump; across a slow loudness swing
  // the orb should be larger at the loud end than the quiet end.
  {
    const flat = run(60, 10, 1.0, false, () => 0.5).filter((s) => s.t > 6);
    let lo = Infinity, hi = -Infinity;
    for (const s of flat) { lo = Math.min(lo, s.scale); hi = Math.max(hi, s.scale); }
    add("pulse scale does not jump on kicks", hi - lo < 0.02,
        `range ${(hi - lo).toFixed(4)} at constant loudness`);
    const sweep = run(60, 40, 1.0, false, (t) => 0.55 + 0.07 * Math.sin(t * 0.4))
      .filter((s) => s.t > 12);
    const ranked = [...sweep].sort((a, b) => a.loud - b.loud);
    const n = Math.max(1, Math.floor(ranked.length * 0.2));
    const mean = (arr) => arr.reduce((a, s) => a + s.scale, 0) / arr.length;
    const quiet = mean(ranked.slice(0, n));
    const loud = mean(ranked.slice(-n));
    add("pulse scale tracks loudness", loud > quiet + 0.03,
        `loud ${loud.toFixed(3)} vs quiet ${quiet.toFixed(3)}`);
  }

  // --- frame-rate independence -------------------------------------------
  const a30 = run(30, 10, 1.0, false).filter((s) => s.t > 6);
  const a90 = run(90, 10, 1.0, false).filter((s) => s.t > 6);
  // Compare time-average and peak, not per-phase bins: samples are uniform in
  // TIME, so binning by phase across the beat's step change measures where the
  // samples happened to land rather than whether the motion agrees.
  // Trapezoid, not a left-Riemann sum: summing samples of a decaying
  // exponential systematically over-reads, and over-reads MORE at low frame
  // rates, which would look like a real difference and is not one.
  const stat = (arr) => {
    let area = 0;
    let max = 0;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i].accent > max) max = arr[i].accent;
      if (i > 0) area += ((arr[i].accent + arr[i - 1].accent) / 2) * (arr[i].t - arr[i - 1].t);
    }
    return { mean: area / (arr[arr.length - 1].t - arr[0].t), max };
  };
  const s30 = stat(a30);
  const s90 = stat(a90);
  const dMean = Math.abs(s30.mean - s90.mean);
  const dMax = Math.abs(s30.max - s90.max);
  add("motion identical at 30 and 90 fps", dMean < 0.03 && dMax < 0.06,
      `mean ${s30.mean.toFixed(3)}/${s90.mean.toFixed(3)} peak ${s30.max.toFixed(3)}/${s90.max.toFixed(3)}`);

  // --- no level into velocity --------------------------------------------
  const steady = run(60, 8, 1.0, false);
  const wobbly = run(60, 8, 1.0, true);
  const rate = (arr) => (arr[arr.length - 1].rotY - arr[Math.floor(arr.length / 2)].rotY);
  const drift = Math.abs(rate(wobbly) - rate(steady));
  add("bass wobble does not drive rotation rate", drift < 0.05,
      `rotation over 4 s differs by ${drift.toFixed(4)} rad`);
  let mono = true;
  for (let i = 1; i < steady.length; i++) if (steady[i].rotY < steady[i - 1].rotY - 1e-9) mono = false;
  add("rotation never runs backwards", mono);

  // --- degrades without a grid -------------------------------------------
  const unlocked = run(60, 10, 0.0, false).filter((s) => s.t > 6);
  add("grid disengages at zero confidence", unlocked[unlocked.length - 1].gridMix < 0.05,
      `gridMix ${unlocked[unlocked.length - 1].gridMix.toFixed(3)}`);
  const unlockedApproach = unlocked.filter((s) => s.phase >= 0.85 && s.phase < 0.99).map((s) => s.accent);
  const ua = unlockedApproach.reduce((a, b) => a + b, 0) / unlockedApproach.length;
  add("no anticipation without a grid", ua < approach * 0.5,
      `unlocked approach ${ua.toFixed(3)} vs locked ${approach.toFixed(3)}`);

  // --- loudness must express variation, not sit at a constant -------------
  // Real music arrives AGC-normalised, so the raw envelope only wanders across
  // a narrow band. The glow has to expand that band or it reads as a permanent
  // brightness lift rather than a response.
  {
    const narrow = run(60, 40, 1.0, false, (t) => 0.55 + 0.07 * Math.sin(t * 0.4));
    const after = narrow.filter((s) => s.t > 12);
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (const s of after) { lo = Math.min(lo, s.loud); hi = Math.max(hi, s.loud); sum += s.loud; }
    const mean = sum / after.length;
    add("narrow loudness swing is expanded", hi - lo > 0.35,
        `raw range 0.14 -> glow range ${(hi - lo).toFixed(3)} (${lo.toFixed(2)}..${hi.toFixed(2)})`);
    add("average glow stays near the old constant", mean > 0.4 && mean < 0.78,
        `mean ${mean.toFixed(3)}`);

    // With nothing happening it must settle, not hunt for dynamics that are
    // not there and flicker.
    const flat = run(60, 30, 0.0, false, () => 0.55).filter((s) => s.t > 12);
    let fsum = 0;
    for (const s of flat) fsum += s.loud;
    const fmean = fsum / flat.length;
    let variance = 0;
    for (const s of flat) variance += (s.loud - fmean) ** 2;
    const sd = Math.sqrt(variance / flat.length);
    add("steady passage does not flicker", sd < 0.05, `stddev ${sd.toFixed(4)}`);
    add("steady passage sits mid-scale", fmean > 0.3 && fmean < 0.8, `mean ${fmean.toFixed(3)}`);
  }

  // --- stopping playback must stop the motion ------------------------------
  {
    const s2 = run(60, 16, 1.0, false, undefined, 8);
    const playing = s2.filter((x) => x.t > 5 && x.t < 8);
    const settling = s2.filter((x) => x.t >= 9.5);
    const peakPlaying = Math.max(...playing.map((x) => x.accent));
    const peakAfter = Math.max(...settling.map((x) => x.accent));
    const anticAfter = Math.max(...settling.map((x) => x.antic));
    add("motion is alive while playing", peakPlaying > 0.3, `peak accent ${peakPlaying.toFixed(3)}`);
    add("pausing stops the pulsing within 1.5 s", peakAfter < 0.02,
        `peak accent after pause ${peakAfter.toFixed(4)}`);
    add("pausing stops the anticipation", anticAfter < 0.02, `peak ${anticAfter.toFixed(4)}`);
    add("live gate drops on silence", settling[settling.length - 1].live < 0.02,
        `live ${settling[settling.length - 1].live.toFixed(4)}`);
  }

  // --- anticipation needs something to anticipate --------------------------
  {
    // Locked grid, but the kick stream has gone quiet: promising a beat that
    // nothing supports is what reads as arbitrary bouncing.
    viz._springs = null; viz._prevShifted = undefined; viz._loudMax = undefined; viz._loudMin = undefined;
    const dt = 1 / 60;
    let t = 0, last = 0;
    for (let i = 0; i < 60 * 12; i++) {
      t += dt;
      const phase = (t / (60 / 120)) % 1;
      // No onsets at all after 4 s, but loudness and the grid stay up.
      const quiet = t > 4;
      if (!quiet && phase < last) { /* beat */ }
      last = phase;
      viz.setFrame({
        freq: viz.freq, time: viz.time,
        bass: 0.5, mid: 0.3, high: 0.2, smoothBass: 0.5,
        loudness: 0.55, energy: 0.5, integratedPower: 0.4, gain: 1, peak: 0.5, flux: 0.02, kick: 0,
        odf: { low: 0, mid: 0, high: 0, broadband: 0 }, thresh: { low: 0, mid: 0, high: 0 },
        onset: { low: 0, mid: 0, high: 0 }, hit: { low: 0, mid: 0, high: 0 },
        surprise: { low: 1, mid: 1, high: 1 },
        since: { low: quiet ? (t - 4) * 1000 : 10, mid: 1e6, high: 1e6 },
        bpm: 120, confidence: 1, downbeatConfidence: 0.8, locked: true,
        beatPhase: phase, barPhase: 0.2, phrasePhase: 0.3,
        beatIndex: Math.floor(t / 0.5), barIndex: 0, timeToNextBeat: (1 - phase) * 0.5,
        beat: phase < last, downbeat: false, concentration: 0.5, acfPeak: 0.5,
      });
      viz._tick(dt);
    }
    add("anticipation fades when onsets stop", viz.motion.anticipation < 0.05,
        `${viz.motion.anticipation.toFixed(4)} after 8 s with no kicks`);
  }

  const anyNaN = [...locked, ...a30, ...wobbly, ...unlocked].some(
    (s) => !Number.isFinite(s.accent) || !Number.isFinite(s.scale) || !Number.isFinite(s.rotY)
        || !Number.isFinite(s.live));
  add("nothing goes non-finite", !anyNaN);

  viz.renderer = savedRenderer;
  return JSON.stringify({ results, failed: results.filter((r) => !r.ok).length });
})()
