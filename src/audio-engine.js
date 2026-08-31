"use strict";

/**
 * Soundstage audio engine (P0).
 *
 * Replaces rAF-polled AnalyserNode reads with a fixed-hop analysis clock:
 *
 *   audio thread -> fixed 512-sample hops -> Hann window -> real FFT
 *   -> log buckets (38 Hz .. 15.5 kHz) -> Hz-defined bands -> dt-correct envelopes
 *
 * Why it matters: the old path stacked a 93 ms FFT window, a 0.38 IIR over
 * spectra, and jittery rAF sampling, which smeared a 5 ms kick attack into a
 * ~150 ms bump. Nothing downstream could ever feel like a hit.
 *
 * Budget on the hot path (per hop, ~86/s):
 *   real FFT 2048   ~25-50 us     (half-length complex + untangle)
 *   log bucketing   ~720 reads
 *   bands+envelopes ~256 reads
 * ~0.4% of one core on a modern chip, and it does NOT scale with render rate.
 */
(() => {
  const G =
    typeof globalThis !== "undefined"
      ? globalThis
      : typeof window !== "undefined"
        ? window
        : self;
  if (G.ScvizAudio) return;

  // Display/analysis band layout. Held fixed in Hz so it does not drift when
  // the FFT size changes, and capped below the ~15-16 kHz lowpass that every
  // lossy codec applies -- that keeps a 128k stream and a Go+ 256k stream
  // reading the same instead of the high band jumping on higher tiers.
  const MIN_HZ = 38;
  const MAX_HZ = 15500;
  const BUCKETS = 256;
  const WAVE_POINTS = 512;
  const WAVE_SPAN = 4096; // oscilloscope window, matches the old fftSize
  const TARGET_HOP_HZ = 86; // analysis frames per second
  const WINDOW_SECONDS = 0.046; // ~46 ms, the standard MIR time/frequency trade

  // Perceptual mapping. Same -90..-22 dB window the old code was tuned
  // against, but the top is a soft knee instead of a wall, so loud masters
  // keep some dynamics instead of pinning every bin flat through the chorus.
  const MIN_DB = -90;
  const MAX_DB = -22;
  const DB_SPAN = MAX_DB - MIN_DB;
  const KNEE = 0.86;
  const KNEE_SLOPE = 2.4;

  // Envelope time constants, in SECONDS. Derived from the old per-frame
  // coefficients at their implicit 60 Hz so the feel carries over, but now
  // frame-rate independent: tau = -1 / (60 * ln(1 - alpha)).
  const TAU = {
    peak: 3.0, // was dynPeak *= 0.995
    powerFast: 0.067, // was += (x - y) * 0.22
    powerSlow: 0.658, // was += (x - y) * 0.025
    loudUp: 0.061, // was += (x - y) * 0.24
    loudDown: 0.248, // was += (x - y) * 0.065
    band: 0.084, // was += (x - y) * 0.18
    kick: 0.1105, // was kick *= 0.86
  };

  // Onset layer. Bands are mel-spaced because transients are broadband and a
  // linear axis spends almost all of its resolution where nothing percussive
  // lives.
  const MEL_BANDS = 40;
  const MEL_MIN_HZ = 30;
  const MEL_MAX_HZ = 15500;
  const COMPRESS = 1000; // log(1 + C*mag), the usual onset-detection compression
  const TAU_WHITEN = 2.0; // per-band gain memory, seconds
  const WHITEN_FLOOR = 0.15; // keeps the noise floor from being amplified to 1
  const MEDIAN_WINDOW = 24; // ~280 ms of context for the adaptive threshold
  const TAU_ODF_PEAK = 4.0; // running loudest onset, for strength normalization
  const TAU_ONSET_ATTACK = 0.008;
  const SURPRISE_IDLE = 1.2; // seconds of silence before a stream is "forgotten"
  const TAU_SURPRISE = 2.5;

  /**
   * Three streams rather than one, because a kick, a snare and a hat are
   * different musical events and a single broadband ODF blurs them into one.
   *
   * delta is an absolute floor (stops firing in near-silence), lambda scales
   * the running median, and dominance requires this band to actually own the
   * transient. The last one matters: a sharp snare leaks measurable energy
   * into the kick band through plain spectral splatter, and without a band
   * ratio the kick stream fires on every backbeat. Measured separation on a
   * synthetic kit is ~15x, so the gate is nowhere near tight.
   */
  const STREAMS = [
    { key: "low", lo: 30, hi: 130, delta: 0.006, lambda: 1.9, refractory: 0.085, release: 0.28, dominance: 0.35, minStrength: 0.12 },
    { key: "mid", lo: 130, hi: 2500, delta: 0.006, lambda: 1.7, refractory: 0.06, release: 0.22, dominance: 0, minStrength: 0.10 },
    { key: "high", lo: 2500, hi: 15500, delta: 0.005, lambda: 1.6, refractory: 0.045, release: 0.12, dominance: 0.25, minStrength: 0.08 },
  ];

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const hzToMel = (hz) => 2595 * Math.log10(1 + hz / 700);
  const melToHz = (mel) => 700 * (Math.pow(10, mel / 2595) - 1);
  const nearestPow2 = (v) => {
    let p = 1;
    while (p * 2 <= v) p *= 2;
    return p * 2 - v < v - p ? p * 2 : p;
  };

  /**
   * Real-input FFT via a half-length complex transform.
   * Twice the throughput of zero-padding the imaginary part, which matters
   * because this is the only thing in the pipeline with real cost.
   */
  class RealFFT {
    constructor(n) {
      if (n & (n - 1)) throw new Error("RealFFT size must be a power of two");
      this.n = n;
      const m = (this.m = n >> 1);
      const bits = Math.round(Math.log2(m));
      this.rev = new Uint32Array(m);
      for (let i = 0; i < m; i++) {
        let r = 0;
        for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
        this.rev[i] = r;
      }
      // Twiddles for the length-m complex FFT.
      this.cos = new Float64Array(m >> 1);
      this.sin = new Float64Array(m >> 1);
      for (let i = 0; i < m >> 1; i++) {
        this.cos[i] = Math.cos((-2 * Math.PI * i) / m);
        this.sin[i] = Math.sin((-2 * Math.PI * i) / m);
      }
      // Twiddles for the real-untangle step: e^(-2*pi*i*k/n).
      this.uCos = new Float64Array(m + 1);
      this.uSin = new Float64Array(m + 1);
      for (let k = 0; k <= m; k++) {
        this.uCos[k] = Math.cos((-2 * Math.PI * k) / n);
        this.uSin[k] = Math.sin((-2 * Math.PI * k) / n);
      }
      this.zr = new Float64Array(m);
      this.zi = new Float64Array(m);
    }

    _complex() {
      const { m, rev, zr, zi, cos, sin } = this;
      for (let i = 0; i < m; i++) {
        const j = rev[i];
        if (j > i) {
          let t = zr[i];
          zr[i] = zr[j];
          zr[j] = t;
          t = zi[i];
          zi[i] = zi[j];
          zi[j] = t;
        }
      }
      for (let size = 2; size <= m; size <<= 1) {
        const half = size >> 1;
        const step = m / size;
        for (let i = 0; i < m; i += size) {
          for (let j = i, k = 0; j < i + half; j++, k += step) {
            const c = cos[k];
            const s = sin[k];
            const l = j + half;
            const tr = zr[l] * c - zi[l] * s;
            const ti = zr[l] * s + zi[l] * c;
            zr[l] = zr[j] - tr;
            zi[l] = zi[j] - ti;
            zr[j] += tr;
            zi[j] += ti;
          }
        }
      }
    }

    /**
     * @param {Float32Array} src   ring buffer of samples
     * @param {number} start       index in src of the oldest sample of the frame
     * @param {Float32Array} win   window function, length n
     * @param {Float32Array} out   magnitudes, length n/2 + 1
     * @param {number} scale       applied to every magnitude
     */
    magnitudes(src, start, win, out, scale) {
      const { n, m, zr, zi, uCos, uSin } = this;
      const mask = src.length - 1;
      // Window and pack: z[k] = x[2k] + i*x[2k+1].
      for (let k = 0, s = start; k < m; k++, s += 2) {
        const i0 = (k << 1);
        zr[k] = src[s & mask] * win[i0];
        zi[k] = src[(s + 1) & mask] * win[i0 + 1];
      }
      this._complex();
      // Untangle into the length-n real spectrum, magnitudes only.
      for (let k = 0; k <= m; k++) {
        // Z is periodic in m, so the Nyquist bin wraps back to Z[0].
        const ka = k === m ? 0 : k;
        const kp = (m - k) % m;
        const ar = zr[ka];
        const ai = zi[ka];
        const br = zr[kp];
        const bi = zi[kp];
        const er = (ar + br) * 0.5;
        const ei = (ai - bi) * 0.5;
        const or_ = (ai + bi) * 0.5;
        const oi = -(ar - br) * 0.5;
        const wr = uCos[k];
        const wi = uSin[k];
        const xr = er + (wr * or_ - wi * oi);
        const xi = ei + (wr * oi + wi * or_);
        out[k] = Math.sqrt(xr * xr + xi * xi) * scale;
      }
      void n;
    }
  }

  /**
   * Bands + envelopes. Shared by the engine (fixed 11.6 ms step) and the
   * legacy rAF path, so both get identical, frame-rate-independent dynamics.
   */
  class Features {
    constructor(layout) {
      this.setLayout(layout);
      this.reset();
    }

    setLayout(layout) {
      const n = layout?.buckets || BUCKETS;
      this.buckets = n;
      this.bassEnd = clamp(layout?.bassEnd ?? Math.round(n * 0.18), 1, n - 2);
      this.midEnd = clamp(layout?.midEnd ?? Math.round(n * 0.55), this.bassEnd + 1, n - 1);
    }

    reset() {
      this.dynPeak = 0.28;
      this.dynGain = 1;
      this.powerFast = 0;
      this.powerSlow = 0;
      this.loudness = 0;
      this.integratedPower = 0;
      this.rawSmoothBass = 0;
      this.smoothBass = 0;
      this.bass = 0;
      this.mid = 0;
      this.high = 0;
      this.kick = 0;
      this.energy = 0;
      this.flux = 0;
      this.prev = null;
    }

    _shape(v) {
      const x = clamp((v - 0.035) * Math.min(2.15, this.dynGain * 1.08), 0, 1);
      return Math.pow(x, 0.86);
    }

    /**
     * @param {Float32Array} b  normalized bucket magnitudes (0..~1.28)
     * @param {number} dt       seconds since the previous update
     */
    update(b, dt) {
      const n = this.buckets;
      if (!(dt > 0)) dt = 1 / 60;
      if (dt > 0.25) dt = 0.25;
      if (!this.prev || this.prev.length !== n) this.prev = new Float32Array(n);
      const prev = this.prev;

      const bassEnd = this.bassEnd;
      const midEnd = this.midEnd;
      let bass = 0;
      let mid = 0;
      let high = 0;
      let peak = 0;
      let power = 0;
      let flux = 0;
      for (let i = 0; i < n; i++) {
        const v = b[i];
        power += v * v;
        if (v > peak) peak = v;
        const d = v - prev[i];
        if (d > 0) flux += d;
        prev[i] = v;
        if (i < bassEnd) bass += v;
        else if (i < midEnd) mid += v;
        else high += v;
      }
      bass /= bassEnd;
      mid /= midEnd - bassEnd;
      high /= Math.max(1, n - midEnd);
      this.flux = flux / n;

      const rawPower = Math.sqrt(power / n);
      const kPeak = Math.exp(-dt / TAU.peak);
      this.dynPeak = Math.max(peak, this.dynPeak * kPeak);
      this.dynGain = Math.min(2.2, 0.86 / Math.max(0.18, this.dynPeak));

      const kFast = 1 - Math.exp(-dt / TAU.powerFast);
      const kSlow = 1 - Math.exp(-dt / TAU.powerSlow);
      this.powerFast += (rawPower - this.powerFast) * kFast;
      this.powerSlow += (rawPower - this.powerSlow) * kSlow;
      const sustained = clamp(this.powerFast * this.dynGain * 1.24, 0, 1.2);
      const transient = clamp((this.powerFast - this.powerSlow) * this.dynGain * 3.4, 0, 0.65);
      const loudTarget = clamp(sustained * 0.82 + transient, 0, 1.25);
      const kLoud =
        1 - Math.exp(-dt / (loudTarget > this.loudness ? TAU.loudUp : TAU.loudDown));
      this.loudness += (loudTarget - this.loudness) * kLoud;
      this.integratedPower = this.powerFast;

      const kBand = 1 - Math.exp(-dt / TAU.band);
      this.rawSmoothBass += (bass - this.rawSmoothBass) * kBand;

      bass = this._shape(bass);
      mid = this._shape(mid);
      high = this._shape(high);

      // Still the old level-derivative heuristic; real onset detection is P1.
      // Decay is now wall-clock rather than per-frame, which is why it stops
      // changing character when the renderer throttles.
      this.kick *= Math.exp(-dt / TAU.kick);
      if (bass > this.smoothBass + 0.08) {
        this.kick = Math.min(1, (bass - this.smoothBass) * 3.6 + bass * 0.45);
      }
      this.bass = bass;
      this.mid = mid;
      this.high = high;
      this.smoothBass += (bass - this.smoothBass) * kBand;
      this.energy = Math.min(1.15, bass * 0.48 + mid * 0.34 + high * 0.18);
      return this;
    }
  }

  /**
   * Triangular mel filterbank over FFT bins. Weights are normalized per band
   * so a wide high band and a narrow low band produce comparable magnitudes.
   */
  class MelBank {
    constructor(sampleRate, fftSize, bands = MEL_BANDS) {
      const bins = fftSize >> 1;
      const binHz = sampleRate / fftSize;
      const fmax = Math.min(MEL_MAX_HZ, sampleRate * 0.45);
      const lo = hzToMel(MEL_MIN_HZ);
      const hi = hzToMel(fmax);
      const edges = new Float64Array(bands + 2);
      for (let i = 0; i < bands + 2; i++) {
        edges[i] = melToHz(lo + ((hi - lo) * i) / (bands + 1)) / binHz;
      }
      this.bands = bands;
      this.centerHz = new Float32Array(bands);
      this.start = new Uint16Array(bands);
      this.len = new Uint16Array(bands);
      this.offset = new Uint32Array(bands);
      const weights = [];
      for (let b = 0; b < bands; b++) {
        const l = edges[b];
        const c = edges[b + 1];
        const r = edges[b + 2];
        // A zero-width filter is possible at the bottom where bins are coarser
        // than the mel spacing; widen it to at least one bin.
        let from = Math.max(1, Math.floor(l));
        let to = Math.min(bins - 1, Math.ceil(r));
        if (to <= from) to = Math.min(bins - 1, from + 1);
        this.centerHz[b] = c * binHz;
        this.start[b] = from;
        this.len[b] = to - from + 1;
        this.offset[b] = weights.length;
        let sum = 0;
        const local = [];
        for (let k = from; k <= to; k++) {
          const w = k < c ? (k - l) / Math.max(1e-9, c - l) : (r - k) / Math.max(1e-9, r - c);
          const v = Math.max(0, w);
          local.push(v);
          sum += v;
        }
        if (sum <= 0) {
          for (let i = 0; i < local.length; i++) local[i] = 1 / local.length;
        } else {
          for (let i = 0; i < local.length; i++) local[i] /= sum;
        }
        for (const v of local) weights.push(v);
      }
      this.weights = Float32Array.from(weights);
    }

    apply(mag, out) {
      const { bands, start, len, offset, weights } = this;
      for (let b = 0; b < bands; b++) {
        const from = start[b];
        const n = len[b];
        const off = offset[b];
        let acc = 0;
        for (let i = 0; i < n; i++) acc += weights[off + i] * mag[from + i];
        out[b] = acc;
      }
      return out;
    }

    /** Inclusive band index range covering [loHz, hiHz). */
    range(loHz, hiHz) {
      let from = this.bands;
      let to = -1;
      for (let b = 0; b < this.bands; b++) {
        const hz = this.centerHz[b];
        if (hz >= loHz && hz < hiHz) {
          if (b < from) from = b;
          if (b > to) to = b;
        }
      }
      if (to < from) {
        from = clamp(from, 0, this.bands - 1);
        to = from;
      }
      return [from, to];
    }
  }

  /**
   * Per-band adaptive whitening -> per-band spectral flux -> three onset
   * streams with independent adaptive thresholds.
   *
   * Whitening is the single biggest perceptual change here: dividing each band
   * by its own running peak means a hi-hat reads as strongly as a kick,
   * instead of being buried by one global AGC that only ever sees the bass.
   */
  class OnsetLayer {
    constructor(melBank) {
      this.mel = melBank;
      const n = melBank.bands;
      this.compressed = new Float32Array(n);
      this.gainPeak = new Float32Array(n).fill(WHITEN_FLOOR);
      this.white = new Float32Array(n);
      this.prevWhite = new Float32Array(n);
      this.flux = new Float32Array(n);
      this.odf = 0;
      this.time = 0;

      this.streams = STREAMS.map((cfg) => {
        const [from, to] = melBank.range(cfg.lo, cfg.hi);
        return {
          cfg,
          from,
          to,
          count: to - from + 1,
          odf: 0,
          prevOdf: 0,
          accent: 0,
          thresh: 0,
          peak: 1e-3,
          env: 0,
          target: 0,
          hit: 0,
          surprise: 0,
          avgStrength: 0,
          lastOnset: -1e9,
          sinceMs: 1e6,
          history: new Float32Array(MEDIAN_WINDOW),
          head: 0,
          filled: 0,
          scratch: new Float32Array(MEDIAN_WINDOW),
        };
      });
      this.byKey = {};
      for (const s of this.streams) this.byKey[s.cfg.key] = s;
    }

    update(mag, dt) {
      this.time += dt;
      const mel = this.mel;
      const n = mel.bands;
      const c = this.compressed;
      const peak = this.gainPeak;
      const white = this.white;
      const prev = this.prevWhite;
      const flux = this.flux;

      mel.apply(mag, c);
      const decay = Math.exp(-dt / TAU_WHITEN);
      let broadband = 0;
      for (let b = 0; b < n; b++) {
        const v = Math.log10(1 + COMPRESS * c[b]);
        c[b] = v;
        const decayed = WHITEN_FLOOR + (peak[b] - WHITEN_FLOOR) * decay;
        const p = v > decayed ? v : decayed;
        peak[b] = p;
        const w = v / p;
        white[b] = w;
        const d = w - prev[b];
        flux[b] = d > 0 ? d : 0;
        broadband += flux[b];
        prev[b] = w;
      }
      this.odf = broadband / n;

      const now = this.time;
      // Two passes: dominance compares a stream against its siblings, so every
      // detection function has to exist before any trigger is decided.
      for (const s of this.streams) {
        let sum = 0;
        let energy = 0;
        for (let b = s.from; b <= s.to; b++) {
          sum += flux[b];
          energy += c[b];
        }
        s.next = sum / s.count;
        // Un-whitened band energy. Whitening deliberately destroys loudness
        // differences between bands, which is right for detection and wrong
        // for accent -- a downbeat is precisely a loudness statement.
        s.accent = energy / s.count;
      }
      for (const s of this.streams) {
        const odf = s.next;

        const med = this._median(s);
        s.thresh = s.cfg.delta + s.cfg.lambda * med;
        s.peak = Math.max(odf, s.peak * Math.exp(-dt / TAU_ODF_PEAK));

        let rival = 0;
        if (s.cfg.dominance > 0) {
          for (const o of this.streams) if (o !== s && o.next > rival) rival = o.next;
        }
        const owns = s.cfg.dominance <= 0 || odf >= s.cfg.dominance * rival;

        // Relative rather than absolute noise floor: the decay tail of a hit
        // still produces flux, and once the running median drops the adaptive
        // threshold alone will let it through. Scaling against the recent
        // loudest onset also means the gate travels with the material instead
        // of being a genre-specific magic number.
        const strength = clamp(odf / Math.max(1e-6, s.peak), 0, 1);

        s.hit = 0;
        // Rising-edge trigger with a refractory window rather than a local
        // maximum: a local max needs a frame of lookahead, and for visuals the
        // flash belongs on the attack, not on the peak.
        if (
          owns &&
          strength >= s.cfg.minStrength &&
          odf > s.thresh &&
          odf > s.prevOdf &&
          now - s.lastOnset > s.cfg.refractory
        ) {
          s.lastOnset = now;
          s.hit = strength;
          s.target = Math.max(s.target, strength);
          // Surprisal relative to how busy this stream has recently been: the
          // 40th kick of a four-on-the-floor section is not an event, the
          // first one after a breakdown is.
          s.surprise = clamp(strength / (s.avgStrength + 0.15), 0, 3);
          s.avgStrength += (strength - s.avgStrength) * 0.2;
        } else if (owns && now - s.lastOnset <= s.cfg.refractory && strength > s.target) {
          // Still inside the same transient. A fixed hop can catch an attack
          // mid-split and under-read its size by several times, so let the
          // envelope keep climbing to the real peak. The trigger itself has
          // already fired, so this costs no latency.
          s.target = strength;
        }
        // Forget the running expectation only once the stream has actually
        // gone quiet. Decaying it every hop would starve it under a steady
        // groove and make every ordinary hit read as a surprise.
        if (now - s.lastOnset > SURPRISE_IDLE) {
          s.avgStrength *= Math.exp(-dt / TAU_SURPRISE);
        }
        s.sinceMs = (now - s.lastOnset) * 1000;

        s.target *= Math.exp(-dt / s.cfg.release);
        const rising = s.target > s.env;
        const tau = rising ? TAU_ONSET_ATTACK : s.cfg.release;
        s.env += (s.target - s.env) * (1 - Math.exp(-dt / tau));

        this._pushHistory(s, odf);
        s.prevOdf = s.odf;
        s.odf = odf;
      }
      return this;
    }

    _pushHistory(s, v) {
      s.history[s.head] = v;
      s.head = (s.head + 1) % MEDIAN_WINDOW;
      if (s.filled < MEDIAN_WINDOW) s.filled++;
    }

    /** Insertion sort over 24 values; cheaper than anything clever at this size. */
    _median(s) {
      const n = s.filled;
      if (n === 0) return 0;
      const a = s.scratch;
      for (let i = 0; i < n; i++) a[i] = s.history[i];
      for (let i = 1; i < n; i++) {
        const v = a[i];
        let j = i - 1;
        while (j >= 0 && a[j] > v) {
          a[j + 1] = a[j];
          j--;
        }
        a[j + 1] = v;
      }
      return n & 1 ? a[(n - 1) >> 1] : (a[n / 2 - 1] + a[n / 2]) * 0.5;
    }
  }

  /**
   * Beat clock tuning. Everything is in seconds or BPM so the values mean
   * something when read.
   */
  const BEAT = {
    ringSeconds: 8,
    acfSeconds: 5, // correlation window: 10 beats at 120 BPM, and locks in ~5 s
    acfInterval: 0.25,
    minBpm: 60,
    maxBpm: 200,
    priorBpm: 125,
    priorWidth: 0.9, // octaves, 1 sigma
    phaseBins: 32,
    histTau: 4.0, // phase histogram memory
    offsetTau: 1.2, // how fast the reported phase settles onto the onsets
    offsetSlew: 0.4, // cap offset motion at this fraction of the phase advance
    switchMargin: 1.35, // a rival must beat the incumbent by this much...
    switchHold: 4.0, // ...for this long, before the tempo is allowed to move
    switchConfidenceBias: 0.5, // and by more still while we are confident
    unlockConfidence: 0.2, // below this for unlockSeconds, start over
    unlockSeconds: 4,
    // Below this analysis rate the detection function is sampled too coarsely
    // and too irregularly for the autocorrelation to be trusted -- measured on
    // the rAF fallback at 30 Hz it reports 127 and 158 BPM on a 120 BPM loop.
    // Reporting no lock is strictly better than driving visuals off a wrong
    // grid; the confidence gate then falls back to reactive envelopes.
    minRate: 50,
    downbeatRate: 0.18, // per-class accent EMA, in bars
    downbeatSeed: 3, // measure every bar position this often before defending one
    downbeatMargin: 1.06,
    downbeatHold: 4, // and the rival must stay ahead for this many beats
    minAcf: 0.05,
  };

  /**
   * Tempo and phase.
   *
   * Autocorrelation over the onset detection function proposes a period; a
   * phase-locked loop free-runs at that period and takes only small,
   * continuous corrections. Nothing here ever jumps, which is the entire
   * point: a tracker that is 99% accurate but flips octaves twice a song
   * looks far worse than one that is slightly off and never wavers.
   */
  class BeatClock {
    constructor(rate) {
      // Sized for twice the nominal rate: the fallback pumps run at rAF, which
      // on a 120 Hz display is faster than the hop rate this was built with.
      const headroom = rate * 2;
      const ringLen = nearestPow2(Math.ceil(BEAT.ringSeconds * headroom));
      this.ring = new Float32Array(ringLen);
      this.mask = ringLen - 1;
      this.written = 0;
      this.work = new Float32Array(Math.min(ringLen, Math.ceil(BEAT.acfSeconds * headroom)));
      const maxPossibleLag = Math.ceil((60 / BEAT.minBpm) * headroom);
      this.acf = new Float32Array(maxPossibleLag + 1);
      this.score = new Float32Array(maxPossibleLag + 1);
      this.prior = new Float32Array(maxPossibleLag + 1);
      const nb = BEAT.phaseBins;
      this.hist = new Float32Array(nb);
      this.dbScore = new Float32Array(4);
      this.dbSeen = new Uint8Array(4);
      this.rateEma = rate;
      this._setRate(rate);

      this.time = 0;
      this.acfAt = -1e9;
      this.acfPeriod = 0;
      this.period = 0;
      this.locked = false;
      this.lockScore = 0;
      this.rivalPeriod = 0;
      this.rivalSince = 0;
      this.lostFor = 0;
      this.phase = 0;
      this.rawPhase = 0;
      this.offset = 0;
      this.offsetReady = false;
      this.beatIndex = 0;
      this.acfPeak = 0;
      this.concentration = 0;
      this.confidence = 0;
      this.downbeatConfidence = 0;
      this.beat = false;
      this.downbeat = false;
      this.downbeatOffset = 0;
      this.dbRival = -1;
      this.dbRivalBars = 0;
      this.accentBeat = null;
      this.accentLow = 0;
      this.accentMid = 0;
      this.accentHigh = 0;
      this.accentOdf = 0;
      // Diagnostic only: per bar position, the mean accent in each band.
      this.dbBands = new Float32Array(16);
      this.barPhase = 0;
      this.phrasePhase = 0;
      this.barIndex = 0;
    }

    /**
     * Lags only mean a tempo relative to the rate frames actually arrive at.
     * Getting this wrong does not just scale the answer -- it distorts the
     * tempo prior, which then selects the wrong harmonic entirely.
     */
    _setRate(rate, reset = true) {
      this.rate = rate;
      this.usable = rate >= BEAT.minRate;
      this.win = Math.min(this.work.length, Math.ceil(BEAT.acfSeconds * rate));
      this.minLag = Math.max(2, Math.floor((60 / BEAT.maxBpm) * rate));
      this.maxLag = Math.min(this.win - 2, this.prior.length - 1,
        Math.ceil((60 / BEAT.minBpm) * rate));
      this.prior.fill(0);
      for (let L = this.minLag; L <= this.maxLag; L++) {
        const bpm = (60 * rate) / L;
        const o = Math.log2(bpm / BEAT.priorBpm) / BEAT.priorWidth;
        this.prior[L] = Math.exp(-0.5 * o * o);
      }
      // Only the lag/period conversion depends on the frame rate. The period
      // is already in seconds and the phase histogram is indexed by phase, so
      // a rate correction must not throw the lock away -- doing that is itself
      // a visible phase jump.
      if (!reset) return;
      this.locked = false;
      this.acfPeriod = 0;
      this.period = 0;
      this.offsetReady = false;
      this.hist.fill(0);
      this.dbScore.fill(0);
      this.dbSeen.fill(0);
    }

    get bpm() {
      return this.period > 0 ? 60 / this.period : 0;
    }

    update(odf, dt, lowAccent, midAccent, highAccent) {
      this.time += dt;
      if (dt > 1e-4) {
        this.rateEma += (1 / dt - this.rateEma) * 0.01;
        if (Math.abs(this.rateEma / this.rate - 1) > 0.04) this._setRate(this.rateEma, false);
      }
      this.ring[this.written++ & this.mask] = odf;
      this.beat = false;
      this.downbeat = false;
      if (!this.usable) {
        this.locked = false;
        this.confidence = 0;
        this.downbeatConfidence = 0;
        return this;
      }
      if (this.time - this.acfAt >= BEAT.acfInterval && this.written >= this.win) {
        this.acfAt = this.time;
        this._estimateTempo();
      }
      this._advance(odf, dt, lowAccent, midAccent, highAccent);
      return this;
    }

    _estimateTempo() {
      const N = this.win;
      const x = this.work;
      const ring = this.ring;
      const mask = this.mask;
      const start = this.written - N;
      let mean = 0;
      for (let i = 0; i < N; i++) {
        const v = ring[(start + i) & mask];
        x[i] = v;
        mean += v;
      }
      mean /= N;
      let energy = 0;
      for (let i = 0; i < N; i++) {
        x[i] -= mean;
        energy += x[i] * x[i];
      }
      if (energy < 1e-9) {
        this.acfPeak = 0;
        return;
      }

      const acf = this.acf;
      const minLag = this.minLag;
      const maxLag = this.maxLag;
      for (let L = minLag; L <= maxLag; L++) {
        let sum = 0;
        for (let i = L; i < N; i++) sum += x[i] * x[i - L];
        // Unbiased: shorter overlaps at long lags would otherwise look weaker
        // purely because fewer terms contribute.
        acf[L] = (sum / energy) * (N / (N - L));
      }

      // Harmonic accumulation. A true beat period also has correlation peaks
      // at 2x and 3x, so summing them promotes the fundamental over its
      // subdivisions -- which is what stops the octave flips that are by far
      // the most visually destructive failure mode.
      const score = this.score;
      let best = 0;
      let bestL = 0;
      for (let L = minLag; L <= maxLag; L++) {
        const h2 = 2 * L <= maxLag ? acf[2 * L] : 0;
        const h3 = 3 * L <= maxLag ? acf[3 * L] : 0;
        const v = this.prior[L] * (acf[L] + 0.5 * h2 + 0.25 * h3);
        score[L] = v;
        if (v > best) {
          best = v;
          bestL = L;
        }
      }
      if (!bestL || acf[bestL] < BEAT.minAcf) {
        this.acfPeak = bestL ? acf[bestL] : 0;
        return;
      }
      this.acfPeak = acf[bestL];
      // Parabolic interpolation around the correlation peak. Integer lags are
      // far too coarse on their own: at ~94 Hz, adjacent lags near 120 BPM are
      // 2.6 BPM apart, and a 2% period error walks the phase a whole beat
      // every 50 beats faster than the loop can pull it back.
      let refined = bestL;
      if (bestL > minLag && bestL < maxLag) {
        const a = acf[bestL - 1];
        const b = acf[bestL];
        const c = acf[bestL + 1];
        const denom = a - 2 * b + c;
        if (denom < -1e-9) {
          const d = (0.5 * (a - c)) / denom;
          if (d > -1 && d < 1) refined = bestL + d;
        }
      }
      const period = refined / this.rate;
      this.acfPeriod = period;

      if (!this.locked) {
        this.locked = true;
        this.period = period;
        this.lockScore = best;
        this.rivalPeriod = 0;
        return;
      }

      const lockL = Math.round(this.period * this.rate);
      const held = lockL >= minLag && lockL <= maxLag ? score[lockL] : 0;
      this.lockScore = held;
      // Scale the bar by how well the current lock is working. Metric flips
      // (a 4:3 triplet feel, a half-time breakdown) briefly win the raw score
      // on real records; a tracker that follows them flips twice a song, which
      // looks far worse than being slightly wrong and never moving.
      const bar = BEAT.switchMargin * (1 + this.confidence * BEAT.switchConfidenceBias);
      // Within one track the tempo either stays, doubles, or halves. A 4:3 or
      // 3:2 relation to the current lock is a triplet or shuffle feel being
      // misread as the pulse, not a new tempo, so demand far more of it. Not
      // an outright veto: confidence collapsing still forces a fresh lock.
      const rel = Math.abs(Math.log2(period / this.period));
      const dev = Math.abs(rel - Math.round(rel));
      const octaveLike = 0.3 + 0.7 * Math.exp(-(dev * dev) / (2 * 0.05 * 0.05));
      if (best * octaveLike > held * bar) {
        // A rival has to stay ahead, not just win one window.
        if (this.rivalPeriod && Math.abs(period / this.rivalPeriod - 1) < 0.04) {
          if (this.time - this.rivalSince >= BEAT.switchHold) {
            this.period = period;
            this.rivalPeriod = 0;
            this.hist.fill(0);
            this.offsetReady = false;
            this.dbScore.fill(0);
            this.dbSeen.fill(0);
          }
        } else {
          this.rivalPeriod = period;
          this.rivalSince = this.time;
        }
      } else {
        this.rivalPeriod = 0;
        // Track small tempo drift within the current lock without resetting.
        if (Math.abs(period / this.period - 1) < 0.05) {
          this.period += (period - this.period) * 0.15;
        }
      }
    }

    _advance(odf, dt, lowAccent, midAccent, highAccent) {
      if (!this.locked || !(this.period > 0)) {
        this.confidence = 0;
        this.downbeatConfidence = 0;
        return;
      }
      // Escape hatch: if the lock stops explaining the music at all, drop it
      // and estimate from scratch rather than defending it forever.
      if (this.confidence < BEAT.unlockConfidence) {
        this.lostFor += dt;
        if (this.lostFor > BEAT.unlockSeconds) {
          this.locked = false;
          this.lostFor = 0;
          this.offsetReady = false;
          this.hist.fill(0);
          this.confidence = 0;
          this.downbeatConfidence = 0;
          return;
        }
      } else {
        this.lostFor = 0;
      }
      const nb = BEAT.phaseBins;
      const advance = dt / this.period;

      // rawPhase free-runs and is NEVER corrected. Everything is measured
      // against it, so the measurement can't be perturbed by its own
      // correction -- which is what made the earlier PLL oscillate and drag
      // the period 3% off a correct estimate.
      this.rawPhase += advance;
      this.rawPhase -= Math.floor(this.rawPhase);

      const decay = Math.exp(-dt / BEAT.histTau);
      const hist = this.hist;
      for (let b = 0; b < nb; b++) hist[b] *= decay;
      let bin = (this.rawPhase * nb) | 0;
      if (bin < 0) bin = 0;
      else if (bin >= nb) bin = nb - 1;
      hist[bin] += odf;

      // Peak, not circular mean. Offbeat hats put a second lobe half a beat
      // away, and the mean of a bimodal distribution lands between the lobes.
      let total = 0;
      let bmax = 0;
      let hmax = -1;
      for (let b = 0; b < nb; b++) {
        const w = hist[b];
        total += w;
        if (w > hmax) {
          hmax = w;
          bmax = b;
        }
      }
      const wm = hist[(bmax - 1 + nb) % nb];
      const w0 = hist[bmax];
      const wp = hist[(bmax + 1) % nb];
      const local = wm + w0 + wp;
      // Fraction of the beat's onset energy in the peak lobe. A click train
      // approaches 1; scattered material sits near 3/nb.
      this.concentration = total > 1e-9 ? local / total : 0;

      if (local > 1e-9) {
        const sub = (wp - wm) / local; // three-point centroid, sub-bin
        let peak = (bmax + 0.5 + sub) / nb;
        peak -= Math.floor(peak);
        if (!this.offsetReady) {
          this.offset = peak;
          this.offsetReady = true;
        } else {
          let delta = peak - this.offset;
          delta -= Math.round(delta); // take the short way around the circle
          let step = delta * (1 - Math.exp(-dt / BEAT.offsetTau));
          // Cap the slew below the phase advance so the reported phase is
          // always monotonic. A phase that briefly runs backwards to correct
          // itself is exactly the visible stutter this is meant to avoid.
          const cap = advance * BEAT.offsetSlew;
          if (step > cap) step = cap;
          else if (step < -cap) step = -cap;
          this.offset += step;
          this.offset -= Math.floor(this.offset);
        }
      }

      // The offset absorbs any residual tempo error on its own, so the period
      // is left as the autocorrelation found it. No integral term, nothing to
      // wind up.
      const prev = this.phase;
      let phase = this.rawPhase - this.offset;
      phase -= Math.floor(phase);
      this.phase = phase;
      if (phase < prev) {
        this.beatIndex++;
        this.beat = true;
      }

      // Calibrate against what scattered material would give, not against a
      // click train. Three of 32 bins is 0.094 if onsets are spread evenly, so
      // that is the floor; real music that locks well sits around 3x it.
      // Measured against a click train instead, a perfectly tracked techno
      // record reports ~0.3 confidence and every grid-driven visual switches
      // itself off exactly when it would look best.
      const uniform = 3 / nb;
      const relative = this.concentration / uniform;
      const conc = clamp((relative - 1.3) / 2.2, 0, 1);
      const strength = clamp(this.acfPeak / 0.1, 0, 1);
      this.confidence = conc * strength;

      // Downbeat by accumulation over the four bar positions. Because it is
      // one argmax over many bars rather than a per-bar decision, it cannot
      // flicker -- which is exactly the failure people notice.
      // Beat-synchronous accent. Onsets fire on the rising edge of the
      // detection function, just before the phase wrap, so sampling at the
      // trigger instant both mis-times the accent and catches it mid-attack.
      // Take the peak over each beat window instead.
      const nearestBeat = this.phase > 0.5 ? this.beatIndex + 1 : this.beatIndex;
      if (this.accentBeat === null) this.accentBeat = nearestBeat;
      if (nearestBeat !== this.accentBeat) {
        // Only once the grid is trustworthy: evidence gathered while the phase
        // is still settling is charged to the wrong bar position, and with a
        // 20 s memory that outlives the beats that caused it.
        if (this.confidence > 0.5) {
          const closed = ((this.accentBeat % 4) + 4) % 4;
          // Kick is evidence for "one"; a backbeat snare is evidence against.
          const evidence = this.accentLow - 0.5 * this.accentMid;
          // Per-class EMA, not a decaying sum. A decaying sum sawtooths: each
          // class spikes when credited and fades for the next three beats, so
          // the argmax just tracks whichever beat happened most recently and
          // "one" lands somewhere new every bar.
          if (!this.dbSeen[closed]) {
            this.dbScore[closed] = evidence;
            this.dbSeen[closed] = 1;
          } else {
            this.dbScore[closed] += (evidence - this.dbScore[closed]) * BEAT.downbeatRate;
          }
          const o4 = closed * 4;
          const r4 = this.dbSeen[closed] ? BEAT.downbeatRate : 1;
          this.dbBands[o4] += (this.accentLow - this.dbBands[o4]) * r4;
          this.dbBands[o4 + 1] += (this.accentMid - this.dbBands[o4 + 1]) * r4;
          this.dbBands[o4 + 2] += (this.accentHigh - this.dbBands[o4 + 2]) * r4;
          this.dbBands[o4 + 3] += (this.accentOdf - this.dbBands[o4 + 3]) * r4;
          if (this.dbSeen[closed] < 255) this.dbSeen[closed]++;
          this._chooseDownbeat();
        }
        this.accentBeat = nearestBeat;
        this.accentLow = 0;
        this.accentMid = 0;
        this.accentHigh = 0;
        this.accentOdf = 0;
      }
      if (lowAccent > this.accentLow) this.accentLow = lowAccent;
      if (midAccent > this.accentMid) this.accentMid = midAccent;
      if (highAccent > this.accentHigh) this.accentHigh = highAccent;
      if (odf > this.accentOdf) this.accentOdf = odf;
      // Reported separately from beat confidence, and usually much lower.
      // Bar position is marked by harmony and arrangement at least as much as
      // by drum accent; on four-on-the-floor with no backbeat there is often
      // no percussive evidence at all, and this says so instead of guessing.
      let dbMax = -Infinity;
      let dbSum = 0;
      for (let i = 0; i < 4; i++) {
        dbSum += this.dbScore[i];
        if (this.dbScore[i] > dbMax) dbMax = this.dbScore[i];
      }
      const dbMean = dbSum / 4;
      this.downbeatConfidence =
        dbMax > 1e-6 ? clamp(((dbMax - dbMean) / dbMax) * 8, 0, 1) * this.confidence : 0;

      const rel = (((this.beatIndex - this.downbeatOffset) % 4) + 4) % 4;
      this.barPhase = (rel + this.phase) / 4;
      this.barIndex = Math.floor((this.beatIndex - this.downbeatOffset) / 4);
      this.phrasePhase = ((((this.barIndex % 8) + 8) % 8) + this.barPhase) / 8;
      if (this.beat && rel === 0) this.downbeat = true;

    }

    /**
     * Runs once per beat, never per hop. Until every bar position has been
     * measured a few times there is nothing to defend, so follow the argmax;
     * after that a rival must win by a margin and hold it for several bars,
     * because a downbeat that migrates around the bar is worse than none.
     */
    _chooseDownbeat() {
      let bestScore = -Infinity;
      let bestIdx = 0;
      let minSeen = 0xffff;
      for (let i = 0; i < 4; i++) {
        if (this.dbScore[i] > bestScore) {
          bestScore = this.dbScore[i];
          bestIdx = i;
        }
        if (this.dbSeen[i] < minSeen) minSeen = this.dbSeen[i];
      }
      if (minSeen < BEAT.downbeatSeed || bestIdx === this.downbeatOffset) {
        if (minSeen < BEAT.downbeatSeed) this.downbeatOffset = bestIdx;
        this.dbRival = -1;
        this.dbRivalBars = 0;
        return;
      }
      if (bestScore > this.dbScore[this.downbeatOffset] * BEAT.downbeatMargin) {
        if (this.dbRival === bestIdx) {
          if (++this.dbRivalBars >= BEAT.downbeatHold) {
            this.downbeatOffset = bestIdx;
            this.dbRival = -1;
            this.dbRivalBars = 0;
          }
        } else {
          this.dbRival = bestIdx;
          this.dbRivalBars = 1;
        }
      } else {
        this.dbRival = -1;
        this.dbRivalBars = 0;
      }
    }

    get timeToNextBeat() {
      return this.period > 0 ? (1 - this.phase) * this.period : 0;
    }
  }

  /** dB -> 0..1 with a soft knee on top instead of a hard clip. */
  function dbNorm(mag) {
    const db = 20 * Math.log10(mag + 1e-9);
    let x = (db - MIN_DB) / DB_SPAN;
    if (x <= 0) return 0;
    if (x > KNEE) {
      const over = x - KNEE;
      x = KNEE + over / (1 + over * KNEE_SLOPE);
    }
    return x;
  }

  class AudioEngine {
    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} source
     * @param {{workletUrl?: string, onFrame?: Function, onStatus?: Function}} opts
     */
    constructor(ctx, source, opts = {}) {
      this.ctx = ctx;
      this.source = source;
      this.opts = opts;
      this.onFrame = opts.onFrame || null;
      this.sampleRate = ctx.sampleRate || 44100;

      // Derive hop and window from the device rate so 44.1k/48k/96k all land
      // near 86 Hz analysis and ~46 ms windows. Hop is a multiple of 128 (the
      // worklet render quantum) so no quantum is ever split across hops.
      const rawHop = this.sampleRate / TARGET_HOP_HZ;
      this.hop = Math.max(128, Math.round(rawHop / 128) * 128);
      this.frame = Math.max(512, nearestPow2(this.sampleRate * WINDOW_SECONDS));
      this.hopSeconds = this.hop / this.sampleRate;
      this.hopRate = this.sampleRate / this.hop;

      const ringSize = nearestPow2(Math.max(this.frame, WAVE_SPAN) * 2);
      this.ring = new Float32Array(ringSize);
      this.ringMask = ringSize - 1;
      this.written = 0;

      this.fft = new RealFFT(this.frame);
      this.win = new Float32Array(this.frame);
      for (let i = 0; i < this.frame; i++) {
        this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.frame);
      }
      // Match Chrome's AnalyserNode magnitude scaling (|X| / fftSize) so the
      // existing -90..-22 dB tuning carries over unchanged.
      this.magScale = 1 / this.frame;
      this.mag = new Float32Array((this.frame >> 1) + 1);

      this._buildLayout();
      this.bands = new Float32Array(BUCKETS);
      this.freq = new Uint8Array(BUCKETS);
      this.time = new Uint8Array(WAVE_POINTS).fill(128);
      this.features = new Features(this.layout);
      this.melBank = new MelBank(this.sampleRate, this.frame);
      this.onsets = new OnsetLayer(this.melBank);
      this.clock = new BeatClock(this.hopRate);

      this.source_ = "none";
      this.node = null;
      this.sink = null;
      this.hops = 0;
      this.gaps = 0;
      this.lastHopIndex = -1;
      this.lastAudioTime = 0;
      this.costMs = 0;
      this.active = false;
      this.frameOut = {
        t: 0,
        hop: 0,
        sampleRate: this.sampleRate,
        freq: this.freq,
        time: this.time,
        bands: this.bands,
        bass: 0,
        mid: 0,
        high: 0,
        smoothBass: 0,
        rawSmoothBass: 0,
        kick: 0,
        loudness: 0,
        energy: 0,
        integratedPower: 0,
        flux: 0,
        gain: 1,
        peak: 0,
        // Onset layer. `hit` is non-zero only on the hop an onset fires, so
        // consumers rendering slower than the analysis clock must accumulate
        // it rather than sample it; `onset` envelopes never miss an event.
        // `hit` carries the strength seen at the trigger hop, which can
        // under-read when an attack straddles a hop boundary. `onset` is
        // refined over the refractory window, so prefer it for amplitude and
        // use `hit` for "something happened, spawn one".
        odf: { low: 0, mid: 0, high: 0, broadband: 0 },
        thresh: { low: 0, mid: 0, high: 0 },
        onset: { low: 0, mid: 0, high: 0 },
        hit: { low: 0, mid: 0, high: 0 },
        surprise: { low: 0, mid: 0, high: 0 },
        since: { low: 1e6, mid: 1e6, high: 1e6 },
        // Beat clock (P2). `beatPhase` free-runs and is predictive: read it
        // rather than waiting for `beat`, and use `timeToNextBeat` to start a
        // move before the beat lands. `confidence` is 0 on material with no
        // usable pulse, which is the cue to fall back to reactive envelopes.
        bpm: 0,
        confidence: 0,
        downbeatConfidence: 0,
        locked: false,
        beatPhase: 0,
        barPhase: 0,
        phrasePhase: 0,
        beatIndex: 0,
        barIndex: 0,
        timeToNextBeat: 0,
        beat: false,
        downbeat: false,
        concentration: 0,
        acfPeak: 0,
      };
    }

    /** Bucket edges, in Hz, resolved to the current FFT resolution. */
    _buildLayout() {
      const binHz = this.sampleRate / this.frame;
      const bins = this.frame >> 1;
      const minIdx = Math.max(1, Math.round(MIN_HZ / binHz));
      const maxIdx = Math.min(bins - 1, Math.round(MAX_HZ / binHz));
      const span = Math.max(2, maxIdx / minIdx);
      this.binHz = binHz;
      this.minIdx = minIdx;
      this.maxIdx = maxIdx;
      this.span = span;
      this.baseHz = minIdx * binHz;
      this.lo = new Uint16Array(BUCKETS);
      this.hi = new Uint16Array(BUCKETS);
      for (let i = 0; i < BUCKETS; i++) {
        const lo = Math.max(minIdx, Math.floor(minIdx * Math.pow(span, i / BUCKETS)));
        const hi = Math.max(lo + 1, Math.floor(minIdx * Math.pow(span, (i + 1) / BUCKETS)));
        this.lo[i] = lo;
        this.hi[i] = Math.min(hi, maxIdx + 1);
      }
      const bucketOf = (hz) =>
        clamp(
          Math.round((BUCKETS * Math.log(hz / this.baseHz)) / Math.log(span)),
          1,
          BUCKETS - 2
        );
      // 43-120 Hz / 120-1000 Hz / 1000-15500 Hz. Reproduces what the old
      // bucket-index fractions happened to land on, but stated in Hz so it
      // cannot silently move when the bucket count or FFT size changes.
      this.layout = {
        buckets: BUCKETS,
        bassEnd: bucketOf(120),
        midEnd: bucketOf(1000),
      };
    }

    async start() {
      if (this.active) return this.source_;
      this.active = true;
      // opts.force pins a tier for debugging; otherwise degrade worklet ->
      // ScriptProcessor (main thread, can glitch under load) -> rAF polling
      // (no fixed hops, but still unclipped and unsmoothed).
      const force = this.opts.force;
      try {
        if (force === "polling") this._startPolling();
        else if (force === "scriptprocessor") this._startScriptProcessor();
        else await this._startWorklet();
      } catch {
        try {
          if (force) throw new Error("forced tier unavailable");
          this._startScriptProcessor();
        } catch {
          this._startPolling();
        }
      }
      this.opts.onStatus?.(this.status());
      return this.source_;
    }

    async _startWorklet() {
      const url = this.opts.workletUrl;
      if (!url || !this.ctx.audioWorklet) throw new Error("no worklet");
      // addModule re-evaluates the module, and a second registerProcessor with
      // the same name throws. Cache per context so toggling playing mode off
      // and on again does not permanently break the worklet path.
      if (!this.ctx.__scvizWorklet) {
        this.ctx.__scvizWorklet = this.ctx.audioWorklet.addModule(url).catch((err) => {
          this.ctx.__scvizWorklet = null;
          throw err;
        });
      }
      await this.ctx.__scvizWorklet;
      const node = new AudioWorkletNode(this.ctx, "scviz-tap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: { hop: this.hop },
      });
      node.port.onmessage = (event) => {
        const d = event.data;
        this._push(d.s, d.s.length);
        this._analyse(d.t, d.i);
      };
      this._connect(node);
      this.source_ = "worklet";
    }

    _startScriptProcessor() {
      if (!this.ctx.createScriptProcessor) throw new Error("no scriptprocessor");
      const node = this.ctx.createScriptProcessor(this.hop, 2, 1);
      const mono = new Float32Array(this.hop);
      let index = 0;
      node.onaudioprocess = (event) => {
        const inp = event.inputBuffer;
        const a = inp.getChannelData(0);
        const b = inp.numberOfChannels > 1 ? inp.getChannelData(1) : null;
        const len = Math.min(this.hop, a.length);
        for (let i = 0; i < len; i++) mono[i] = b ? (a[i] + b[i]) * 0.5 : a[i];
        this._push(mono, len);
        this._analyse(event.playbackTime || this.ctx.currentTime, index++);
      };
      this._connect(node);
      this.source_ = "scriptprocessor";
    }

    /**
     * Last resort: rAF-polled analyser. Same shape as the old pipeline but
     * with smoothing off and float data, so it is still an improvement --
     * it just cannot promise fixed hops.
     */
    _startPolling() {
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = this.frame;
      analyser.smoothingTimeConstant = 0;
      this.source.connect(analyser);
      this.node = analyser;
      this.source_ = "polling";
      const buf = new Float32Array(analyser.fftSize);
      let index = 0;
      let prevTime = this.ctx.currentTime;
      const tick = () => {
        if (!this.active) return;
        const now = this.ctx.currentTime;
        const dt = Math.max(1e-4, now - prevTime);
        prevTime = now;
        analyser.getFloatTimeDomainData(buf);
        // rAF does not tell us how much audio elapsed, so derive it from the
        // audio clock and append exactly that much. Appending a fixed hop
        // would leave gaps in the ring and the FFT frame would be stitched
        // from non-contiguous audio.
        const fresh = Math.min(buf.length, Math.max(1, Math.round(dt * this.sampleRate)));
        this._push(buf.subarray(buf.length - fresh), fresh);
        this._analyse(now, index++, dt);
        this._pollRaf = requestAnimationFrame(tick);
      };
      this._pollRaf = requestAnimationFrame(tick);
    }

    /**
     * Audio nodes are pulled from the destination, so a leaf tap can be
     * skipped entirely. Route through a silent gain to guarantee it runs
     * without adding anything audible.
     */
    _connect(node) {
      const sink = this.ctx.createGain();
      sink.gain.value = 0;
      this.source.connect(node);
      node.connect(sink);
      sink.connect(this.ctx.destination);
      this.node = node;
      this.sink = sink;
    }

    _push(src, len) {
      const ring = this.ring;
      const mask = this.ringMask;
      let w = this.written;
      for (let i = 0; i < len; i++) ring[(w + i) & mask] = src[i];
      this.written = w + len;
    }

    _analyse(audioTime, hopIndex, dt = this.hopSeconds) {
      if (this.written < this.frame) return;
      const t0 = performance.now();

      if (this.lastHopIndex >= 0 && hopIndex - this.lastHopIndex > 1) {
        this.gaps += hopIndex - this.lastHopIndex - 1;
      }
      this.lastHopIndex = hopIndex;
      this.lastAudioTime = audioTime;
      this.hops++;

      const start = this.written - this.frame;
      this.fft.magnitudes(this.ring, start, this.win, this.mag, this.magScale);

      const mag = this.mag;
      const bands = this.bands;
      const freq = this.freq;
      const lo = this.lo;
      const hi = this.hi;
      for (let i = 0; i < BUCKETS; i++) {
        const a = lo[i];
        const b = hi[i];
        let peak = 0;
        let sum = 0;
        for (let j = a; j < b; j++) {
          const v = mag[j];
          sum += v;
          if (v > peak) peak = v;
        }
        const count = b - a;
        // Same peak-biased blend the old display used, so the bars keep their
        // look; the difference is that it is now unclipped and unsmoothed.
        const v = count > 0 ? dbNorm(0.4 * (sum / count) + 0.6 * peak) : 0;
        bands[i] = v;
        freq[i] = v >= 1 ? 255 : (v * 255) | 0;
      }

      const f = this.features.update(bands, dt);
      const on = this.onsets.update(mag, dt);
      // Weight bar-position evidence by the RAW detection function, not by the
      // onset strength: strength is normalized against a running peak, which
      // flattens exactly the loudness difference that marks a downbeat.
      const clock = this.clock.update(
        on.odf, dt, on.byKey.low.accent, on.byKey.mid.accent, on.byKey.high.accent
      );
      this._fillWave();

      const out = this.frameOut;
      out.t = audioTime;
      out.hop = hopIndex;
      out.bass = f.bass;
      out.mid = f.mid;
      out.high = f.high;
      out.smoothBass = f.smoothBass;
      out.rawSmoothBass = f.rawSmoothBass;
      out.loudness = f.loudness;
      out.energy = f.energy;
      out.integratedPower = f.integratedPower;
      out.gain = f.dynGain;
      out.peak = f.dynPeak;

      const low = on.byKey.low;
      const mid = on.byKey.mid;
      const high = on.byKey.high;
      out.odf.low = low.odf;
      out.odf.mid = mid.odf;
      out.odf.high = high.odf;
      out.odf.broadband = on.odf;
      out.thresh.low = low.thresh;
      out.thresh.mid = mid.thresh;
      out.thresh.high = high.thresh;
      out.onset.low = low.env;
      out.onset.mid = mid.env;
      out.onset.high = high.env;
      out.hit.low = low.hit;
      out.hit.mid = mid.hit;
      out.hit.high = high.hit;
      out.surprise.low = low.surprise;
      out.surprise.mid = mid.surprise;
      out.surprise.high = high.surprise;
      out.since.low = low.sinceMs;
      out.since.mid = mid.sinceMs;
      out.since.high = high.sinceMs;
      // Compatibility: everything downstream still reads `kick`, but it is now
      // a detected kick envelope rather than "the bass level went up a bit".
      out.kick = low.env;
      out.flux = on.odf;

      out.bpm = clock.bpm;
      out.confidence = clock.confidence;
      out.locked = clock.locked;
      out.downbeatConfidence = clock.downbeatConfidence;
      out.beatPhase = clock.phase;
      out.barPhase = clock.barPhase;
      out.phrasePhase = clock.phrasePhase;
      out.beatIndex = clock.beatIndex;
      out.barIndex = clock.barIndex;
      out.timeToNextBeat = clock.timeToNextBeat;
      out.beat = clock.beat;
      out.downbeat = clock.downbeat;
      out.concentration = clock.concentration;
      out.acfPeak = clock.acfPeak;

      // Exponential average so a single slow hop does not dominate the readout.
      this.costMs += (performance.now() - t0 - this.costMs) * 0.05;
      this.onFrame?.(out);
    }

    _fillWave() {
      const ring = this.ring;
      const mask = this.ringMask;
      const span = Math.min(WAVE_SPAN, this.written);
      const start = this.written - span;
      const step = span / WAVE_POINTS;
      const time = this.time;
      for (let i = 0; i < WAVE_POINTS; i++) {
        const v = ring[(start + ((i * step) | 0)) & mask];
        const b = 128 + v * 127;
        time[i] = b < 0 ? 0 : b > 255 ? 255 : b | 0;
      }
    }

    status() {
      return {
        source: this.source_,
        sampleRate: this.sampleRate,
        hop: this.hop,
        frame: this.frame,
        hopRate: this.hopRate,
        hops: this.hops,
        gaps: this.gaps,
        costMs: this.costMs,
      };
    }

    stop() {
      if (!this.active) return;
      this.active = false;
      if (this._pollRaf) cancelAnimationFrame(this._pollRaf);
      this._pollRaf = 0;
      try {
        if (this.node?.port) this.node.port.onmessage = null;
        if (this.node) this.node.onaudioprocess = null;
        this.source.disconnect(this.node);
        this.node?.disconnect();
        this.sink?.disconnect();
      } catch {
        // graph may already be torn down
      }
      this.node = null;
      this.sink = null;
    }
  }

  G.ScvizAudio = {
    AudioEngine,
    Features,
    RealFFT,
    MelBank,
    OnsetLayer,
    BeatClock,
    STREAMS,
    BEAT,
    dbNorm,
    BUCKETS,
    WAVE_POINTS,
    MIN_HZ,
    MAX_HZ,
    TAU,
    defaultLayout: { buckets: BUCKETS, bassEnd: 45, midEnd: 137 },
  };
})();
