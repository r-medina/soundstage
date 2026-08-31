"use strict";

/**
 * Motion primitives for the visual layer (P3).
 *
 * The rule these exist to enforce: audio drives FORCES, never positions.
 * `scale = bassLevel` jitters because every wobble in the signal is a wobble
 * on screen. An impulse into a spring punches, overshoots and settles, because
 * the spring supplies the follow-through that makes motion read as physical.
 *
 * Everything here is dt-correct and stable at any frame rate, so a machine
 * dropping to 30 fps changes how smooth the visuals are and not how they feel.
 */
(() => {
  const G = typeof globalThis !== "undefined" ? globalThis : window;
  if (G.ScvizMotion) return;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a || 1e-9), 0, 1);
    return t * t * (3 - 2 * t);
  };

  /** Damped harmonic oscillator. Substepped so it cannot blow up on a long frame. */
  class Spring {
    constructor(freq = 5, damping = 1) {
      this.freq = freq;
      this.damping = damping;
      this.x = 0;
      this.v = 0;
    }

    impulse(a) {
      this.v += a;
      return this;
    }

    set(x) {
      this.x = x;
      this.v = 0;
      return this;
    }

    update(dt) {
      if (!(dt > 0)) return this.x;
      // A stalled frame should not teleport the visual, so advance at most
      // this much simulated time however long the frame actually was.
      if (dt > 0.1) dt = 0.1;

      // Closed form, not numerical integration. A linear spring has an exact
      // solution, so this is identical at 15 fps and 144 fps, cannot go
      // unstable on a long frame, and costs less than substepping would.
      const w = this.freq * 6.283185307179586;
      const z = this.damping;
      const x0 = this.x;
      const v0 = this.v;
      const decay = Math.exp(-z * w * dt);

      if (Math.abs(z - 1) < 1e-3) {
        // Critically damped.
        const c = v0 + w * x0;
        this.x = decay * (x0 + c * dt);
        this.v = decay * (c - w * (x0 + c * dt));
      } else if (z < 1) {
        const wd = w * Math.sqrt(1 - z * z);
        const cs = Math.cos(wd * dt);
        const sn = Math.sin(wd * dt);
        const b = (v0 + z * w * x0) / wd;
        this.x = decay * (x0 * cs + b * sn);
        this.v = -z * w * this.x + decay * wd * (b * cs - x0 * sn);
      } else {
        // Overdamped: two real roots, no oscillation.
        const r = w * Math.sqrt(z * z - 1);
        const r1 = -z * w + r;
        const r2 = -z * w - r;
        const c1 = (v0 - r2 * x0) / (r1 - r2);
        const c2 = x0 - c1;
        const e1 = Math.exp(r1 * dt);
        const e2 = Math.exp(r2 * dt);
        this.x = c1 * e1 + c2 * e2;
        this.v = c1 * r1 * e1 + c2 * r2 * e2;
      }
      return this.x;
    }
  }

  /** Asymmetric attack/release follower. Fast up, slow down -- the shape that
   *  makes a level read as a hit rather than a swell. */
  class Envelope {
    constructor(attack = 0.01, release = 0.3) {
      this.attack = attack;
      this.release = release;
      this.value = 0;
    }

    push(target, dt) {
      if (!(dt > 0)) return this.value;
      const tau = target > this.value ? this.attack : this.release;
      this.value += (target - this.value) * (1 - Math.exp(-dt / tau));
      return this.value;
    }

    /**
     * Trigger-and-decay: hold the peak, then fall. Call decay() BEFORE
     * trigger() each frame -- decaying afterwards shaves part of the peak off
     * on slow frames, so the same beat lands softer at 30 fps than at 144.
     */
    trigger(amount) {
      if (amount > this.value) this.value = amount;
      return this.value;
    }

    decay(dt) {
      this.value *= Math.exp(-dt / this.release);
      return this.value;
    }
  }

  /**
   * The anticipation ramp: 0 through most of the beat, rising smoothly to 1 as
   * the beat approaches.
   *
   * Only the SWELL is a function of phase. The hit itself must be a triggered
   * envelope, not a peak in a phase curve -- a curve with an instantaneous
   * maximum is sampled wherever the frame happens to land, so the same beat
   * reads at 0.66 on a 30 fps machine and 0.85 on a 90 fps one. Held
   * envelopes and springs capture their peak at any frame rate.
   */
  function swell(phase, antic = 0.28) {
    const p = phase - Math.floor(phase);
    const start = 1 - antic;
    if (p < start) return 0;
    const u = (p - start) / antic;
    return u * u * (3 - 2 * u);
  }

  /** Slow swell across a bar or phrase: builds through, releases at the top. */
  function archShape(phase, power = 2.2) {
    const p = phase - Math.floor(phase);
    return Math.pow(p, power);
  }

  G.ScvizMotion = { Spring, Envelope, swell, archShape, clamp, smoothstep };
})();
