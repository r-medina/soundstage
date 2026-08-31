"use strict";

/**
 * Audio debug HUD. You cannot tune onset thresholds, tempo priors, or envelope
 * shapes blind, so this ships alongside the analysis rather than after it.
 *
 * Top block is the analysis clock (pump tier, measured rate, dropped hops,
 * cost, buffer latency). Below that: the spectrum, then one lane per onset
 * stream showing its detection function against its adaptive threshold with
 * ticks where an onset actually fired. If the ticks do not line up with what
 * you hear, that is the bug.
 *
 * Costs nothing while hidden; repaints at 30 Hz while shown, independent of
 * the analysis rate.
 */
(() => {
  const G = typeof globalThis !== "undefined" ? globalThis : window;
  if (G.ScvizAudioHud) return;

  const W = 560;
  const HISTORY = 400; // ~4.6 s at 86 Hz
  const SPEC_H = 50;
  const LANE_H = 30;
  const HEAD_H = 58;
  const REPAINT_MS = 33;
  const LABEL_W = 46;

  const SERIES = {
    loudness: (f) => f.loudness,
    bass: (f) => f.bass,
    mid: (f) => f.mid,
    high: (f) => f.high,
    odfLow: (f) => f.odf?.low || 0,
    odfMid: (f) => f.odf?.mid || 0,
    odfHigh: (f) => f.odf?.high || 0,
    thrLow: (f) => f.thresh?.low || 0,
    thrMid: (f) => f.thresh?.mid || 0,
    thrHigh: (f) => f.thresh?.high || 0,
    hitLow: (f) => f.hit?.low || 0,
    hitMid: (f) => f.hit?.mid || 0,
    hitHigh: (f) => f.hit?.high || 0,
    envLow: (f) => f.onset?.low || 0,
    envMid: (f) => f.onset?.mid || 0,
    envHigh: (f) => f.onset?.high || 0,
    beatPhase: (f) => f.beatPhase || 0,
    barPhase: (f) => f.barPhase || 0,
    beatTick: (f) => (f.beat ? 1 : 0),
    downTick: (f) => (f.downbeat ? 1 : 0),
  };

  // `auto` lanes rescale to their own recent maximum. Flux magnitudes vary by
  // orders of magnitude between tracks, so a fixed scale is unreadable.
  const LANES = [
    { label: "loud", max: 1.3, lines: [["loudness", "#ffffff"]] },
    { label: "levels", max: 1.05, lines: [["bass", "#ff8a3d"], ["mid", "#7bdc7b"], ["high", "#6f8cff"]] },
    { label: "kick", auto: "odfLow", min: 0.02, lines: [["odfLow", "#ff8a3d"], ["thrLow", "rgba(255,138,61,0.42)"]], ticks: ["hitLow", "#ffd0a0"] },
    { label: "snare", auto: "odfMid", min: 0.02, lines: [["odfMid", "#7bdc7b"], ["thrMid", "rgba(123,220,123,0.42)"]], ticks: ["hitMid", "#c8f0c8"] },
    { label: "hats", auto: "odfHigh", min: 0.02, lines: [["odfHigh", "#6f8cff"], ["thrHigh", "rgba(111,140,255,0.42)"]], ticks: ["hitHigh", "#c0ccff"] },
    { label: "env", max: 1.05, lines: [["envLow", "#ff8a3d"], ["envMid", "#7bdc7b"], ["envHigh", "#6f8cff"]] },
    // Sawtooth should be a clean ramp with ticks at the resets. A ramp that
    // stutters or ticks that drift off the resets means the PLL is not locked.
    { label: "beat", max: 1.02, lines: [["beatPhase", "#ffd24d"], ["barPhase", "rgba(255,210,77,0.35)"]], ticks: ["downTick", "#ffffff"], ticks2: ["beatTick", "rgba(255,210,77,0.55)"] },
  ];

  class AudioHud {
    constructor(opts = {}) {
      this.ctxAudio = opts.audioContext || null;
      this.visible = false;
      this.height = HEAD_H + SPEC_H + LANES.length * LANE_H + 6;

      this.canvas = document.createElement("canvas");
      this.canvas.className = "scviz-audio-hud";
      Object.assign(this.canvas.style, {
        position: "fixed",
        left: "12px",
        bottom: "12px",
        width: `${W}px`,
        height: `${this.height}px`,
        zIndex: "2147483000",
        pointerEvents: "none",
        borderRadius: "6px",
        display: "none",
        background: "rgba(6,7,10,0.84)",
        boxShadow: "0 6px 24px rgba(0,0,0,0.45)",
      });
      this.ctx = this.canvas.getContext("2d", { alpha: true });

      this.series = new Map();
      for (const key of Object.keys(SERIES)) this.series.set(key, new Float32Array(HISTORY));
      this.head = 0;
      this.spectrum = new Uint8Array(256);

      this.status = { source: "-", hopRate: 0, gaps: 0, costMs: 0, frame: 0, sampleRate: 0 };
      this.gain = 1;
      this.peak = 0;
      this.pushes = 0;
      this.measuredHz = 0;
      this.rateAt = 0;
      this.latencyMs = 0;
      this.onsetCounts = { low: 0, mid: 0, high: 0 };
      this.onsetRates = { low: 0, mid: 0, high: 0 };
      this.beat = { bpm: 0, confidence: 0, concentration: 0, acfPeak: 0, barIndex: 0 };
      this.renderFrames = 0;
      this.renderFps = 0;
      this.renderAt = 0;
      this.lastPaint = 0;
      this.raf = 0;
      this.dpr = 0;
    }

    mount(parent) {
      (parent || document.body).appendChild(this.canvas);
      return this;
    }

    destroy() {
      this.hide();
      this.canvas.remove();
    }

    toggle() {
      return this.visible ? (this.hide(), false) : (this.show(), true);
    }

    show() {
      if (this.visible) return;
      this.visible = true;
      this.canvas.style.display = "block";
      this._resize();
      const loop = () => {
        if (!this.visible) return;
        const now = performance.now();
        if (now - this.lastPaint >= REPAINT_MS) {
          this.lastPaint = now;
          this._paint();
        }
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }

    hide() {
      this.visible = false;
      this.canvas.style.display = "none";
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    }

    /** Called once per analysis hop. Cheap enough to leave on while hidden. */
    push(frame) {
      const h = this.head;
      for (const [key, ring] of this.series) ring[h] = SERIES[key](frame) || 0;
      this.head = (h + 1) % HISTORY;
      this.pushes++;
      this.gain = frame.gain || 1;
      this.peak = frame.peak || 0;
      if (frame.bpm !== undefined) {
        this.beat.bpm = frame.bpm;
        this.beat.confidence = frame.confidence;
        this.beat.concentration = frame.concentration;
        this.beat.acfPeak = frame.acfPeak;
        this.beat.barIndex = frame.barIndex;
      }
      if (frame.hit) {
        for (const k of ["low", "mid", "high"]) if (frame.hit[k] > 0) this.onsetCounts[k]++;
      }
      if (this.visible && frame.freq) this.spectrum.set(frame.freq);
      if (this.ctxAudio && frame.t) {
        // How far behind the audio clock the newest analysed sample is.
        const l = (this.ctxAudio.currentTime - frame.t) * 1000;
        this.latencyMs += (l - this.latencyMs) * 0.05;
      }
      const now = performance.now();
      if (now - this.rateAt >= 1000) {
        const span = (now - this.rateAt) / 1000;
        this.measuredHz = this.pushes / span;
        for (const k of ["low", "mid", "high"]) {
          this.onsetRates[k] = this.onsetCounts[k] / span;
          this.onsetCounts[k] = 0;
        }
        this.pushes = 0;
        this.rateAt = now;
      }
    }

    /** Called once per rendered visual frame, purely to compare the two clocks. */
    tickRender() {
      this.renderFrames++;
      const now = performance.now();
      if (now - this.renderAt >= 1000) {
        this.renderFps = (this.renderFrames * 1000) / (now - this.renderAt);
        this.renderFrames = 0;
        this.renderAt = now;
      }
    }

    setStatus(status) {
      if (status) Object.assign(this.status, status);
    }

    _resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (dpr === this.dpr) return;
      this.dpr = dpr;
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(this.height * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    _paint() {
      this._resize();
      const c = this.ctx;
      const s = this.status;
      c.clearRect(0, 0, W, this.height);
      c.font = "10px ui-monospace,SFMono-Regular,Menlo,monospace";
      c.textBaseline = "top";

      const nominal = s.hopRate || 0;
      const drift = nominal ? Math.abs(this.measuredHz - nominal) : 0;
      const healthy = s.source === "worklet" && drift < 3 && s.gaps === 0;
      c.fillStyle = healthy ? "#7bdc7b" : "#ffd24d";
      c.fillText(
        `pump ${s.source}  ${this.measuredHz.toFixed(1)}/${nominal.toFixed(1)} Hz  gaps ${s.gaps}`,
        8,
        7
      );
      c.fillStyle = "rgba(255,255,255,0.62)";
      c.fillText(
        `fft ${s.frame} @ ${(s.sampleRate / 1000).toFixed(1)}k  cost ${s.costMs.toFixed(3)} ms/hop  lat ${this.latencyMs.toFixed(0)} ms`,
        8,
        20
      );
      const last = (this.head - 1 + HISTORY) % HISTORY;
      c.fillText(
        `render ${this.renderFps.toFixed(0)} fps  agc ${this.gain.toFixed(2)}  peak ${this.peak.toFixed(2)}  loud ${this.series.get("loudness")[last].toFixed(2)}`,
        8,
        33
      );
      const b = this.beat;
      const locked = b.confidence > 0.45;
      c.fillStyle = locked ? "#ffd24d" : "rgba(255,255,255,0.45)";
      c.fillText(
        `${b.bpm ? b.bpm.toFixed(1) : "--"} bpm  conf ${b.confidence.toFixed(2)}` +
          `  conc ${b.concentration.toFixed(2)}  acf ${b.acfPeak.toFixed(2)}  bar ${b.barIndex}`,
        250,
        7
      );
      const r = this.onsetRates;
      c.fillStyle = "rgba(255,255,255,0.62)";
      c.fillText("onsets/s", 8, 46);
      const rateColors = [["low", "#ff8a3d"], ["mid", "#7bdc7b"], ["high", "#6f8cff"]];
      let rx = 62;
      for (const [k, color] of rateColors) {
        c.fillStyle = color;
        const text = `${k} ${r[k].toFixed(1)}`;
        c.fillText(text, rx, 46);
        rx += c.measureText(text).width + 12;
      }

      // Spectrum, as one filled path.
      const specY = HEAD_H;
      c.fillStyle = "rgba(255,255,255,0.05)";
      c.fillRect(6, specY, W - 12, SPEC_H);
      const spec = this.spectrum;
      const bw = (W - 12) / spec.length;
      c.beginPath();
      c.moveTo(6, specY + SPEC_H);
      for (let i = 0; i < spec.length; i++) {
        c.lineTo(6 + i * bw, specY + SPEC_H - (spec[i] / 255) * (SPEC_H - 2));
      }
      c.lineTo(W - 6, specY + SPEC_H);
      c.closePath();
      c.fillStyle = "rgba(120,190,255,0.42)";
      c.fill();

      let y = specY + SPEC_H + 4;
      for (const lane of LANES) {
        const h = LANE_H - 3;
        c.fillStyle = "rgba(255,255,255,0.04)";
        c.fillRect(6, y, W - 12, h);
        c.fillStyle = "rgba(255,255,255,0.34)";
        c.fillText(lane.label, 9, y + 2);
        const scale = lane.auto ? this._autoScale(lane) : lane.max;
        if (lane.ticks2) this._ticks(this.series.get(lane.ticks2[0]), y, h, lane.ticks2[1]);
        if (lane.ticks) this._ticks(this.series.get(lane.ticks[0]), y, h, lane.ticks[1]);
        for (const [key, color] of lane.lines) {
          this._trace(this.series.get(key), y, h, scale, color);
        }
        if (lane.auto) {
          c.fillStyle = "rgba(255,255,255,0.28)";
          const text = scale.toFixed(3);
          c.fillText(text, W - 10 - c.measureText(text).width, y + 2);
        }
        y += LANE_H;
      }
    }

    _autoScale(lane) {
      const ring = this.series.get(lane.auto);
      let max = 0;
      for (let i = 0; i < HISTORY; i++) if (ring[i] > max) max = ring[i];
      return Math.max(lane.min || 0.01, max * 1.15);
    }

    /** Oldest sample sits at head, so the plot scrolls left without a blit. */
    _trace(ring, y, h, max, color) {
      const c = this.ctx;
      const step = (W - 12 - LABEL_W) / HISTORY;
      c.beginPath();
      for (let i = 0; i < HISTORY; i++) {
        const v = ring[(this.head + i) % HISTORY] / max;
        const py = y + h - Math.max(0, Math.min(1, v)) * (h - 2) - 1;
        const px = LABEL_W + i * step;
        if (i === 0) c.moveTo(px, py);
        else c.lineTo(px, py);
      }
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.stroke();
    }

    /** One vertical mark per fired onset, height scaled by its strength. */
    _ticks(ring, y, h, color) {
      const c = this.ctx;
      const step = (W - 12 - LABEL_W) / HISTORY;
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.beginPath();
      for (let i = 0; i < HISTORY; i++) {
        const v = ring[(this.head + i) % HISTORY];
        if (v <= 0) continue;
        const px = Math.round(LABEL_W + i * step) + 0.5;
        c.moveTo(px, y + h - 1);
        c.lineTo(px, y + h - 1 - Math.min(1, v) * (h - 2));
      }
      c.stroke();
    }
  }

  G.ScvizAudioHud = AudioHud;
})();
