// Slow-modulation check. Evaluated against a loaded preview.html:
//
//   node <cdp-driver> http://127.0.0.1:8791/preview.html "$(cat scripts/drift-check.js)"
//
// Fast-forwards four minutes of simulated time with rendering bypassed and
// asserts that the parameters meant to evolve actually do: magnetosphere core
// size, bloom shape, and bloom spin rate. Also re-checks that nothing drives a
// rotation RATE from an audio level, which integrates signal wobble into
// permanent drift.
(() => {
  viz.stop();
  const saved = viz.renderer;
  viz.renderer = null; // measuring parameters over time, not pixels
  const BPM = 124, PERIOD = 60 / BPM;

  const run = (mode, seconds, wobble) => {
    viz.setMode(mode);
    viz._springs = null; viz._prevShifted = undefined; viz._bloomSpin = 0;
    viz.elapsed = 0;
    const dt = 0.1;
    let t = 0, prev = 0;
    const rows = [];
    for (let i = 0; i < seconds / dt; i++) {
      t += dt;
      const phase = (t / PERIOD) % 1;
      const beat = phase < prev; prev = phase;
      const bass = wobble ? 0.45 + 0.4 * Math.sin(t * 31.0) : 0.45;
      for (let b = 0; b < viz.freq.length; b++) viz.freq[b] = Math.max(0, 190 * Math.exp(-b / 45) - b * 0.2);
      viz.setFrame({
        freq: viz.freq, time: viz.time,
        bass, mid: 0.35, high: 0.25, smoothBass: bass,
        loudness: 0.55, energy: 0.5, integratedPower: 0.4, gain: 1, peak: 0.5, flux: 0.03,
        kick: beat ? 0.9 : 0,
        odf: { low: 0, mid: 0, high: 0, broadband: 0 }, thresh: { low: 0, mid: 0, high: 0 },
        onset: { low: beat ? 0.9 : 0.08, mid: 0, high: 0.2 },
        hit: { low: beat ? 0.9 : 0, mid: 0, high: 0 },
        surprise: { low: 1, mid: 1, high: 1 }, since: { low: 0, mid: 0, high: 0 },
        bpm: BPM, confidence: 0.9, downbeatConfidence: 0.7,
        beatPhase: phase, barPhase: (t / (PERIOD * 4)) % 1, phrasePhase: (t / (PERIOD * 32)) % 1,
        beatIndex: Math.floor(t / PERIOD), barIndex: 0, timeToNextBeat: (1 - phase) * PERIOD,
        beat, downbeat: false, concentration: 0.5, acfPeak: 0.5,
      });
      viz._tick(dt);
      rows.push({
        t,
        core: viz.magCoreScale,
        shape: viz.uniforms.bloomShape ? viz.uniforms.bloomShape.value : 0,
        rotY: viz.bloom ? viz.bloom.rotation.y : 0,
      });
    }
    return rows;
  };

  const results = [];
  const add = (name, ok, detail) => results.push({ name, ok, detail });
  const span = (rows, key) => {
    let lo = Infinity, hi = -Infinity;
    for (const r of rows) { if (r[key] < lo) lo = r[key]; if (r[key] > hi) hi = r[key]; }
    return { lo, hi, range: hi - lo };
  };

  const mag = run("magnetosphere", 240, false);
  const c = span(mag, "core");
  add("magnetosphere core size varies over time", c.range > 0.12 && c.range < 0.5,
      `${c.lo.toFixed(3)} .. ${c.hi.toFixed(3)} (range ${c.range.toFixed(3)})`);
  add("core size stays in a sane range", c.lo > 0.4 && c.hi < 2.0 && mag.every((r) => Number.isFinite(r.core)),
      `${c.lo.toFixed(3)} .. ${c.hi.toFixed(3)}`);
  // It must wander rather than cycle. Comparing samples exactly one period of
  // the leading LFO apart is a direct test: a single sine repeats itself there
  // to the last decimal, two incommensurate ones cannot. (Comparing the min
  // and max of each half, which was the first attempt, is a poor proxy -- the
  // extremes can coincide even when the trajectory does not.)
  const PRIMARY = (2 * Math.PI) / 0.117; // seconds, the leading core LFO
  const lag = Math.round(PRIMARY / 0.1);
  let maxSelfDiff = 0;
  for (let i = 0; i + lag < mag.length; i += 25) {
    maxSelfDiff = Math.max(maxSelfDiff, Math.abs(mag[i].core - mag[i + lag].core));
  }
  add("core drift does not repeat on one period", maxSelfDiff > 0.03,
      `max change across one ${PRIMARY.toFixed(0)} s period: ${maxSelfDiff.toFixed(4)}`);

  const bl = run("bloom", 240, false);
  const sh = span(bl, "shape");
  // Wide enough to notice, narrow enough to stay the same visual idea.
  add("bloom shape moves over time, but stays subtle", sh.range > 0.12 && sh.range < 0.34,
      `${sh.lo.toFixed(3)} .. ${sh.hi.toFixed(3)} (range ${sh.range.toFixed(3)})`);
  add("bloom shape stays in range", sh.lo >= 0 && sh.hi <= 1, `${sh.lo.toFixed(3)} .. ${sh.hi.toFixed(3)}`);

  // Spin rate must vary, and never run backwards.
  let mono = true;
  const rates = [];
  for (let i = 1; i < bl.length; i++) {
    if (bl[i].rotY < bl[i - 1].rotY - 1e-9) mono = false;
    rates.push((bl[i].rotY - bl[i - 1].rotY) / 0.1);
  }
  rates.sort((a, b) => a - b);
  const rlo = rates[Math.floor(rates.length * 0.05)];
  const rhi = rates[Math.floor(rates.length * 0.95)];
  // Should breathe, not stall and not bolt.
  add("bloom spin rate modulates without stalling", rhi > rlo * 1.5 && rhi < rlo * 3.5,
      `p5 ${rlo.toFixed(4)} .. p95 ${rhi.toFixed(4)} rad/s`);
  add("bloom spin never runs backwards", mono);

  // And the rate must not follow the bass level any more.
  const steady = run("bloom", 60, false);
  const wobbly = run("bloom", 60, true);
  const total = (rows) => rows[rows.length - 1].rotY - rows[0].rotY;
  const drift = Math.abs(total(steady) - total(wobbly));
  // Bass modulating the spin RATE is intended here (it is the original
  // behaviour, restored on request). What must not happen is a symmetric
  // wobble accumulating into net drift.
  add("symmetric bass wobble accumulates no net drift", drift < 0.02,
      `60 s of rotation differs by ${drift.toFixed(5)} rad`);

  // --- inner and outer spin must be independently controllable ------------
  // They are two speeds in the same units, not a rate and a multiplier of it.
  viz.setMode("bloom");
  {
    const dt = 1 / 60;
    const measure = (inner, outer, seconds) => {
      viz.setParams({ bloomSpin: inner, bloomSwirl: outer });
      viz._bloomSwirl = 0; viz._springs = null;
      // Inner spin accumulates straight onto the object again (that is the
      // original behaviour), so read the rotation, not a helper field.
      const y0 = viz.bloom.rotation.y;
      viz.elapsed = 30;
      for (let i = 0; i < seconds / dt; i++) {
        for (let b = 0; b < viz.freq.length; b++) viz.freq[b] = Math.max(0, 190 * Math.exp(-b / 45) - b * 0.2);
        viz.setFrame({
          freq: viz.freq, time: viz.time, bass: 0.45, mid: 0.3, high: 0.2, smoothBass: 0.45,
          loudness: 0.55, energy: 0.5, integratedPower: 0.4, gain: 1, peak: 0.5, flux: 0.02, kick: 0,
          odf: { low: 0, mid: 0, high: 0, broadband: 0 }, thresh: { low: 0, mid: 0, high: 0 },
          onset: { low: 0, mid: 0, high: 0 }, hit: { low: 0, mid: 0, high: 0 },
          surprise: { low: 1, mid: 1, high: 1 }, since: { low: 1e6, mid: 1e6, high: 1e6 },
          bpm: 120, confidence: 0, downbeatConfidence: 0, locked: false,
          beatPhase: 0, barPhase: 0, phrasePhase: 0, beatIndex: 0, barIndex: 0,
          timeToNextBeat: 0, beat: false, downbeat: false, concentration: 0, acfPeak: 0,
        });
        viz.elapsed = 30;              // hold the slow flow steady
        viz._tick(dt);
        viz.elapsed = 30;
      }
      const innerRate = (viz.bloom.rotation.y - y0) / seconds;
      return { innerRate, outerRate: innerRate + viz._bloomSwirl / seconds };
    };

    const a = measure(1, 1.6, 20);
    add("outer leads the inner when set higher",
        a.outerRate > a.innerRate * 1.55 && a.outerRate < a.innerRate * 1.65,
        `inner ${a.innerRate.toFixed(4)} outer ${a.outerRate.toFixed(4)} (x${(a.outerRate / a.innerRate).toFixed(2)})`);

    // The point of two sliders: either can be zero while the other moves.
    const b = measure(0, 3, 20);
    add("inner can be stopped while the outer spins",
        Math.abs(b.innerRate) < 0.002 && b.outerRate > 0.1,
        `inner ${b.innerRate.toFixed(4)} outer ${b.outerRate.toFixed(4)}`);
    const c = measure(2, 0, 20);
    add("outer can be stopped while the inner spins",
        c.innerRate > 0.1 && Math.abs(c.outerRate) < 0.002,
        `inner ${c.innerRate.toFixed(4)} outer ${c.outerRate.toFixed(4)}`);

    // Rates must be proportional to the slider values, in the same units.
    const d = measure(1, 1, 20);
    const e = measure(2, 2, 20);
    add("equal values turn the cloud rigidly",
        Math.abs(d.innerRate - d.outerRate) < 0.002,
        `inner ${d.innerRate.toFixed(4)} outer ${d.outerRate.toFixed(4)}`);
    add("both sliders scale linearly and share units",
        Math.abs(e.innerRate / d.innerRate - 2) < 0.05,
        `1x ${d.innerRate.toFixed(4)}  2x ${e.innerRate.toFixed(4)}`);

    const f = measure(2.5, 5, 20);
    add("slider maxima give the intended top speeds", f.outerRate > f.innerRate * 1.9,
        `inner ${f.innerRate.toFixed(4)} outer ${f.outerRate.toFixed(4)} rad/s`);



    viz.setParams({ bloomSpin: 1, bloomSwirl: 1.5 });

    // Structural invariant: ONE shear per group. If the shear varied within a
    // group, particles at different radii would rotate at different rates --
    // so "outer stopped" would only stop part of the disc, and the local flow
    // field would be incoherent, which the eye reads as shimmer rather than
    // rotation. Encoded as a test because the symptom (everything looking like
    // it slows down) is nothing like the cause.
    const ringAttr = viz.bloomPoints.geometry.getAttribute("ring");
    const seen = new Map();
    for (let i = 0; i < ringAttr.count; i++) {
      const v = +ringAttr.getX(i).toFixed(4);
      seen.set(v, (seen.get(v) || 0) + 1);
    }
    const groups = [...seen.entries()].sort((x, y) => x[0] - y[0]);
    add("shear is uniform within each group", groups.length <= 4,
        groups.map(([v, n]) => `${v}:${n}`).join("  "));
    add("the core shell never shears", seen.has(0) && seen.get(0) > 100,
        `${seen.get(0) || 0} particles at ring 0`);
    add("the outer disc is one group at one speed", seen.has(1) && seen.get(1) > 100,
        `${seen.get(1) || 0} particles at ring 1`);
  }


  viz.renderer = saved;

  // --- the shear must turn the way the object turns -----------------------
  // Renders for real. Getting this backwards inverts the whole outer slider:
  // the disc's world rate becomes base*(2*inner - outer), so the rings run
  // fastest with the slider at zero and stop dead at maximum.
  viz.setMode("bloom");
  const feed2 = () => {
    for (let b = 0; b < viz.freq.length; b++) viz.freq[b] = Math.max(0, 190 * Math.exp(-b / 45) - b * 0.2);
    viz.setFrame({
      freq: viz.freq, time: viz.time, bass: 0.45, mid: 0.3, high: 0.2, smoothBass: 0.45,
      rawSmoothBass: 0.45, loudness: 0.55, energy: 0.5, integratedPower: 0.4, gain: 1, peak: 0.5,
      flux: 0.02, kick: 0, odf: { low: 0, mid: 0, high: 0, broadband: 0 },
      thresh: { low: 0, mid: 0, high: 0 }, onset: { low: 0, mid: 0, high: 0 },
      hit: { low: 0, mid: 0, high: 0 }, surprise: { low: 1, mid: 1, high: 1 },
      since: { low: 1e6, mid: 1e6, high: 1e6 }, bpm: 120, confidence: 0,
      downbeatConfidence: 0, locked: false, beatPhase: 0, barPhase: 0, phrasePhase: 0,
      beatIndex: 0, barIndex: 0, timeToNextBeat: 0, beat: false, downbeat: false,
      concentration: 0, acfPeak: 0,
    });
  };
  viz.elapsed = 12;
  for (let i = 0; i < 60; i++) { viz.elapsed = 12; feed2(); viz._tick(1 / 60); viz.elapsed = 12; }
  const cv = viz.renderer.domElement;
  const W = cv.width, H = cv.height;
  const c2 = document.createElement("canvas");
  c2.width = W; c2.height = H;
  const cx = c2.getContext("2d");
  const grab = (rotY, swirl) => {
    feed2();
    viz._tick(0);                                   // set everything up, advance nothing
    viz.bloom.rotation.y = rotY;                    // then override and draw directly
    // The object also carries x/z tilt, and Y does not commute with those, so
    // an object-space Y shear only equals a change in rotation.y when the tilt
    // is zero. Flatten it for the comparison.
    viz.bloom.rotation.x = 0;
    viz.bloom.rotation.z = 0;
    viz.uniforms.bloomSwirlAngle.value = swirl;
    viz.renderer.setRenderTarget(null);
    viz.renderer.render(viz.scene, viz.camera);
    cx.clearRect(0, 0, W, H);
    cx.drawImage(cv, 0, 0);
    const d = cx.getImageData(0, 0, W, H).data;
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) lum[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 765;
    return lum;
  };

  const TH = 0.25;

  // Put EVERY particle in the shear group for the duration of the test. The
  // shear then has to be exactly equivalent to rotating the object -- rotation
  // commutes with the uniform xz scaling and is independent of the y scaling
  // that follow it -- so the two frames must come out pixel-identical. Any
  // handedness error shows up immediately instead of being diluted by the
  // groups that legitimately did not move.
  const ringAttr = viz.bloomPoints.geometry.getAttribute("ring");
  const savedRings = Float32Array.from(ringAttr.array);
  ringAttr.array.fill(1);
  ringAttr.needsUpdate = true;

  const base = grab(0, 0);
  const rotated = grab(TH, 0);
  const sheared = grab(0, TH);
  const mirrored = grab(0, -TH);

  ringAttr.array.set(savedRings);
  ringAttr.needsUpdate = true;

  const mean = (a, b) => {
    let s2 = 0;
    for (let i = 0; i < a.length; i++) s2 += Math.abs(a[i] - b[i]);
    return s2 / a.length;
  };
  const dPlus = mean(sheared, rotated);
  const dMinus = mean(mirrored, rotated);
  const spread = mean(rotated, base); // how much a TH rotation changes at all

  add("shearing by an angle equals rotating the object by it",
      dPlus < spread * 0.05,
      `residual ${dPlus.toFixed(5)} vs ${spread.toFixed(5)} for the rotation itself`);
  add("shear turns the same way as the object rotation",
      dMinus > dPlus * 10,
      `matched ${dPlus.toFixed(5)}, mirrored ${dMinus.toFixed(5)}`);


  return JSON.stringify({ results, failed: results.filter((r) => !r.ok).length });
})()
