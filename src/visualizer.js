"use strict";

(() => {
  const MODES = [
    { id: "pulse", label: "Pulse" },
    { id: "ridge", label: "Ridge" },
    { id: "bloom", label: "Bloom" },
    { id: "magnetosphere", label: "Magnetosphere" },
    { id: "dance", label: "Dance" },
  ];
  // The Dance clip is 3.333 s, i.e. 8 beats at 144 BPM. Rate is latched on
  // each downbeat against that, so the figures step with the track without
  // being yanked around by every tempo nudge.
  const DANCE_CLIP_BEATS = 8;
  const DANCERS = 7;
  // Thrown on a downbeat, one dancer at a time.
  const DANCE_ACCENTS = ["Jump", "ThumbsUp", "Wave", "Punch", "Yes"];
  const LEGACY = {
    orb: "pulse",
    bars: "ridge",
    scope: "ridge",
    storm: "bloom",
    tunnel: "pulse",
  };
  const RIDGE_ROWS = 260;
  const RIDGE_COLS = 160;
  const BEAT_LOUD_MEMORY = 7; // seconds of loudness range to normalise against
  const RIDGE_STEP = 0.04;
  // Rows drawn per beat once the clock is locked. Twelve puts the row rate at
  // ~0.041 s around 122 BPM, so the look barely changes -- but the rows now
  // land ON the grid instead of drifting across it.
  const RIDGE_ROWS_PER_BEAT = 12;
  const BLOOM_COUNT = 7000;
  const MAG_ATTRACTORS = 5;
  const MAG_PARTICLES = 1600;
  const MAG_TRAIL = 42;
  const MAG_RIBBONS = 72;
  const MAG_SPIKES = 260;
  const MAG_RING_SEGS = 64;
  const MAG_RINGS_PER_ORB = 2;
  const MAG_CORE_RADIUS = 0.64;
  const MAG_NEBULA = 720;
  const MAG_NO_REFLECT_LAYER = 29;
  const MAG_VOID_LAYER = 30;
  const MAG_SIM_STEP = 1 / 45;
  const FOREGROUND_FPS = 60;
  const BACKGROUND_FPS = 24;

  function magOrbShown(preset, index) {
    if (preset === 0) return index < 3;
    if (preset === 1) return true;
    if (preset === 2) return false;
    return index < 2;
  }

  const SNOISE = `
    vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
    float snoise(vec3 v){
      const vec2 C=vec2(1.0/6.0,1.0/3.0);
      const vec4 D=vec4(0.0,0.5,1.0,2.0);
      vec3 i=floor(v+dot(v,C.yyy));
      vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz);
      vec3 l=1.0-g;
      vec3 i1=min(g.xyz,l.zxy);
      vec3 i2=max(g.xyz,l.zxy);
      vec3 x1=x0-i1+C.xxx;
      vec3 x2=x0-i2+C.yyy;
      vec3 x3=x0-D.yyy;
      i=mod289(i);
      vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
      float n_=0.142857142857;
      vec3 ns=n_*D.wyz-D.xzx;
      vec4 j=p-49.0*floor(p*ns.z*ns.z);
      vec4 x_=floor(j*ns.z);
      vec4 y_=floor(j-7.0*x_);
      vec4 x=x_*ns.x+ns.yyyy;
      vec4 y=y_*ns.x+ns.yyyy;
      vec4 h=1.0-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy);
      vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.0+1.0;
      vec4 s1=floor(b1)*2.0+1.0;
      vec4 sh=-step(h,vec4(0.0));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;
      vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x);
      vec3 p1=vec3(a0.zw,h.y);
      vec3 p2=vec3(a1.xy,h.z);
      vec3 p3=vec3(a1.zw,h.w);
      vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
      vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
      m=m*m;
      return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }
  `;

  class SCVizVisualizer {
    constructor(canvas, waveCanvas, options = {}) {
      this.options = options;
      this.canvas = canvas;
      this.waveCanvas = waveCanvas;
      this.waveCtx = waveCanvas.getContext("2d", { alpha: true });
      this.freq = new Uint8Array(256);
      this.time = new Uint8Array(512).fill(128);
      this.samples = [];
      this.progress = 0;
      this.accent = [255, 85, 0];
      this.energy = 0;
      this.integratedPower = 0;
      this.loudness = 0;
      this.powerFast = 0;
      this.powerSlow = 0;
      this.bass = 0;
      this.mid = 0;
      this.high = 0;
      this.smoothBass = 0;
      this.rawSmoothBass = 0;
      this.kick = 0;
      this.flux = 0;
      // Onset layer (P1). `onset` are envelopes and can be sampled freely;
      // `hit` is a discrete impulse accumulated between renders so an event
      // is never dropped when the analysis clock outruns the render clock.
      this.onset = { low: 0, mid: 0, high: 0 };
      this.surprise = { low: 0, mid: 0, high: 0 };
      this.since = { low: 1e6, mid: 1e6, high: 1e6 };
      this.hit = { low: 0, mid: 0, high: 0 };
      this._pendingHit = { low: 0, mid: 0, high: 0 };
      // Beat clock (P2). `beatPhase` is predictive and free-running, so read
      // it directly rather than waiting for `beat`; `timeToNextBeat` lets a
      // move start before the beat instead of chasing it. Gate anything
      // grid-driven on `beatConfidence` so rubato material degrades to the
      // reactive envelopes rather than looking wrong.
      this.bpm = 0;
      this.beatLocked = false;
      this.beatConfidence = 0;
      this.beatPhase = 0;
      this.barPhase = 0;
      this.phrasePhase = 0;
      this.beatIndex = 0;
      this.barIndex = 0;
      this.timeToNextBeat = 0;
      this.beatHit = false;
      this.downbeatHit = false;
      this.downbeatConfidence = 0;
      this._pendingBeat = false;
      this._pendingDownbeat = false;
      // Derived motion (P3). Modes read these instead of raw levels, so audio
      // supplies forces and the springs decide the pose.
      this.motion = {
        gridMix: 0,
        accent: 0,
        beatAmp: 0.5,
        anticipation: 0,
        bar: 0,
        phrase: 0,
        calm: 1,
        live: 1,
        sensitivity: 1,
        loudness: 0.5,
        spin: 0,
        kick: 0,
        snare: 0,
        hat: 0,
        downbeat: 0,
      };
      this.dynGain = 1;
      this.dynPeak = 0.28;
      // True once a fixed-hop AudioEngine is feeding us. Frames already carry
      // the envelopes, so nothing is recomputed at render rate.
      this.engineDriven = false;
      this.hasAudio = false;
      this.mode = "pulse";
      this.discEl = null;
      this.running = false;
      this.raf = 0;
      this.last = 0;
      this.nextFrameAt = 0;
      this.frameRateTarget = 0;
      this.elapsed = 0;
      this.artUrl = "";
      this.params = {
        bloomBright: 0.72,
        bloomSize: 1,
        bloomSpread: 0.55,
        bloomSpin: 1,
        bloomSwirl: 1.5,
        bloomShape: 0.28,
        bloomHue: 0.72,
        bloomWarm: 0.42,
        bloomSpark: 0.48,
        bloomSoft: 0.55,
        bloomTight: 0,
        ridgeZoom: 2.4,
        ridgeHeight: 1.15,
        ridgeFreq: 1,
        ridgeFuzz: 0.28,
        pulseArt: 1,
        sensitivity: 1,
        loudGlow: 0.85,
        magReflect: 0.52,
        magVoidGlow: 0.12,
        magDensity: 0.88,
        magDensityAuto: 0.58,
        magTrail: 1,
        magRibbon: 1,
        magAtmosphere: 1,
        magBloom: 1,
        magMotion: 1,
        magCoreSize: 1,
      };
      this.liveAccent = [255, 85, 0];
      this.liveAccent2 = [40, 140, 255];
      this.dynPeak = 0.32;
      this.dynGain = 1;
      this._camBase = null;
      this.ridgeAcc = 0;
      this.bloomDance = 0;
      this.magnetosphereMid = null;
      this.magQualityScale = 1;
      this.magCoreScale = 1;
      this.frameMsSmooth = 16.7;
      this._slowRenderSeconds = 0;
      this._fastRenderSeconds = 0;
      this.qualityChanges = 0;
      this.magSeed = (Number(options.magSeed ?? 0x6d2b79f5) >>> 0) || 0x6d2b79f5;
      this.magOptions = {
        forcedPreset: Number.isFinite(options.magPreset) ? options.magPreset | 0 : null,
        freeze: Boolean(options.magFreeze),
        cameraLock: Boolean(options.magCameraLock),
      };
      this._initThree();
    }

    static get modes() {
      return MODES;
    }

    setMode(id) {
      const previous = this.mode;
      const resolved = LEGACY[id] || id;
      this.mode = MODES.some((m) => m.id === resolved) ? resolved : "pulse";
      if (this.pulse) {
        this.pulse.visible = this.mode === "pulse";
        this.ridge.visible = this.mode === "ridge";
        this.bloom.visible = this.mode === "bloom";
        if (this.magnetosphere) this.magnetosphere.visible = this.mode === "magnetosphere";
        if (this.dance) this.dance.visible = this.mode === "dance";
        if (this.mode === "dance") this._loadDancers();
      }
      if (this.scene) {
        this.scene.fog = this.mode === "ridge" ? this.ridgeFog : null;
      }
      if (this.renderer && previous !== this.mode) {
        if (this.mode === "magnetosphere") {
          this._slowRenderSeconds = 0;
          this._fastRenderSeconds = 0;
          this.resize();
        } else {
          if (previous === "magnetosphere") this.magPost?.releaseTargets();
          this.resize();
        }
      }
      this._syncPulseArt();
      return this.mode;
    }

    setDisc() {}

    setMagnetosphereOptions(partial = {}) {
      if ("preset" in partial) {
        const preset = Number(partial.preset);
        this.magOptions.forcedPreset = Number.isFinite(preset) && preset >= 0 ? preset | 0 : null;
      }
      if ("freeze" in partial) this.magOptions.freeze = Boolean(partial.freeze);
      if ("cameraLock" in partial) this.magOptions.cameraLock = Boolean(partial.cameraLock);
    }

    setParams(partial) {
      if (!partial) return;
      Object.assign(this.params, partial);
      const limits = {
        bloomBright: [0.58, 0.85],
        bloomSize: [0.4, 2.2],
        bloomSpread: [0, 1.6],
        bloomSpin: [0, 2.5],
        bloomSwirl: [0, 5],
        bloomShape: [0, 1],
        bloomHue: [0, 1],
        bloomWarm: [0, 1],
        bloomSpark: [0, 1],
        bloomSoft: [0, 1],
        bloomTight: [0, 1],
        ridgeZoom: [2.2, 3.5],
        ridgeHeight: [0.7, 4.5],
        ridgeFreq: [0.2, 1],
        ridgeFuzz: [0, 1],
        pulseArt: [0, 1],
        sensitivity: [0, 2.2],
        loudGlow: [0, 2],
        magReflect: [0, 1],
        magVoidGlow: [0, 1],
        magDensity: [0.1, 1],
        magDensityAuto: [0, 1],
        magTrail: [0.2, 2.5],
        magRibbon: [0, 2.5],
        magAtmosphere: [0, 2],
        magBloom: [0.2, 1.1],
        magMotion: [0.25, 2],
        magCoreSize: [0.6, 1.6],
      };
      for (const [key, range] of Object.entries(limits)) {
        this.params[key] = clamp(this.params[key], range[0], range[1]);
        if (this.uniforms?.[key]) this.uniforms[key].value = this.params[key];
      }
      if (this.ridgeGeo) this._syncRidgeIndex();
      this._syncPulseArt();
    }

    cycleMode() {
      const i = MODES.findIndex((m) => m.id === this.mode);
      this.setMode(MODES[(i + 1) % MODES.length].id);
      return this.mode;
    }

    /**
     * Fixed-hop frame from ScvizAudio.AudioEngine. Preferred path: the
     * spectrum is unclipped and unsmoothed, and the envelopes were stepped on
     * the analysis clock rather than on whatever the renderer managed.
     */
    setFrame(frame) {
      if (!frame) return;
      this.engineDriven = true;
      this.hasAudio = true;
      const freq = frame.freq;
      if (freq?.length) {
        if (this.freq.length !== freq.length) this.freq = new Uint8Array(freq.length);
        this.freq.set(freq);
      }
      const time = frame.time;
      if (time?.length) {
        if (this.time.length !== time.length) this.time = new Uint8Array(time.length);
        this.time.set(time);
      }
      this.bass = frame.bass;
      this.mid = frame.mid;
      this.high = frame.high;
      this.smoothBass = frame.smoothBass;
      // Unshaped bass follower. Bloom's spin rate and dance target both read
      // it, and it was never being copied across -- so it sat at 0 and those
      // terms were silently dead.
      this.rawSmoothBass = frame.rawSmoothBass ?? frame.smoothBass;
      this.kick = frame.kick;
      this.loudness = frame.loudness;
      this.energy = frame.energy;
      this.integratedPower = frame.integratedPower;
      this.flux = frame.flux;
      this.dynGain = frame.gain;
      this.dynPeak = frame.peak;
      if (frame.onset) {
        const pending = this._pendingHit;
        for (const k of ["low", "mid", "high"]) {
          this.onset[k] = frame.onset[k];
          this.surprise[k] = frame.surprise[k];
          this.since[k] = frame.since[k];
          const h = frame.hit[k];
          if (h > pending[k]) pending[k] = h;
        }
      }
      if (frame.bpm !== undefined) {
        this.bpm = frame.bpm;
        this.beatLocked = Boolean(frame.locked);
        this.beatConfidence = frame.confidence;
        this.beatPhase = frame.beatPhase;
        this.barPhase = frame.barPhase;
        this.phrasePhase = frame.phrasePhase;
        this.beatIndex = frame.beatIndex;
        this.barIndex = frame.barIndex;
        this.timeToNextBeat = frame.timeToNextBeat;
        this.downbeatConfidence = frame.downbeatConfidence || 0;
        if (frame.beat) this._pendingBeat = true;
        if (frame.downbeat) this._pendingDownbeat = true;
      }
    }

    /** Legacy path: raw analyser bytes, analysed at render rate. */
    setAudio(freq, time) {
      this.engineDriven = false;
      if (freq?.length) {
        if (this.freq.length !== freq.length) this.freq = new Uint8Array(freq.length);
        this.freq.set(freq);
        this.hasAudio = true;
      }
      if (time?.length) {
        if (this.time?.length !== time.length) this.time = new Uint8Array(time.length);
        this.time.set(time);
      }
    }

    setWaveform(samples) {
      this.samples = Array.isArray(samples) ? samples : [];
    }

    setProgress(ratio) {
      this.progress = Math.min(1, Math.max(0, ratio || 0));
    }

    setAccent(rgb) {
      if (Array.isArray(rgb) && rgb.length >= 3) this.accent = rgb.map((n) => n | 0);
      const [r, g, b] = this.accent;
      if (this.uniforms) {
        this.uniforms.color.value.setRGB(r / 255, g / 255, b / 255);
      }
    }

    setArtwork(url) {
      if (!url || url === this.artUrl || !this.artMat) return;
      this.artUrl = url;
      fetch(url)
        .then((r) => r.blob())
        .then((blob) => {
          const obj = URL.createObjectURL(blob);
          const loader = new THREE.TextureLoader();
          loader.load(obj, (tex) => {
            URL.revokeObjectURL(obj);
            tex.colorSpace = THREE.SRGBColorSpace;
            if (this.artMat.map) this.artMat.map.dispose();
            this.artMat.map = tex;
            this.artMat.needsUpdate = true;
            this._syncPulseArt();
          });
        })
        .catch(() => {});
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      this.nextFrameAt = this.last;
      this.frameRateTarget = 0;
      const loop = (now) => {
        if (!this.running) return;
        try {
          const targetFps = document.hasFocus() ? FOREGROUND_FPS : BACKGROUND_FPS;
          if (targetFps !== this.frameRateTarget) {
            this.frameRateTarget = targetFps;
            this.nextFrameAt = now;
          }
          const interval = 1000 / targetFps;
          if (now + 0.5 < this.nextFrameAt) {
            this.raf = requestAnimationFrame(loop);
            return;
          }
          const dt = Math.min(0.05, (now - this.last) / 1000);
          this.last = now;
          do {
            this.nextFrameAt += interval;
          } while (this.nextFrameAt <= now + 0.5);
          this._tick(dt);
          this.raf = requestAnimationFrame(loop);
        } catch {
          this.running = false;
        }
      };
      this.raf = requestAnimationFrame(loop);
    }

    stop() {
      this.running = false;
      cancelAnimationFrame(this.raf);
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const deviceDpr = window.devicePixelRatio || 1;
      const isMag = this.mode === "magnetosphere";
      const dprCap = isMag ? 1.35 : 1.75;
      const quality = isMag ? this.magQualityScale : 1;
      // Floor stays low on purpose: dropping resolution is the escape hatch for
      // machines that cannot keep up, and raising it would remove that. Edge
      // aliasing is handled by multisampling the render target instead, which
      // buys far more per unit cost than extra pixels -- and is switched off
      // first when the quality scale backs down.
      const dpr = Math.max(0.75, Math.min(dprCap, deviceDpr) * quality);
      if (this.renderer) {
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
        this.camera.aspect = rect.width / Math.max(1, rect.height);
        this.camera.updateProjectionMatrix();
        if (this.magPost && this.mode === "magnetosphere") {
          this._postSize ||= new THREE.Vector2();
          this.renderer.getDrawingBufferSize(this._postSize);
          // MSAA only while there is headroom. The renderer's antialias flag
          // does nothing here because the scene is rendered into a target, so
          // without this magnetosphere is the one mode with no antialiasing.
          const samples = this.magQualityScale >= 0.99 ? 4 : 0;
          this.magPost.resize(this._postSize.x, this._postSize.y, samples);
        }
      }
      if (this.mode === "ridge") {
        const zoom = clamp(this.params.ridgeZoom || 2.4, 2.2, 3.5);
        this._fitRidgeToView((zoom - 2.2) / 1.3);
      }
      fitCanvas(this.waveCanvas, this.waveCtx);
    }

    _updatePerformance(dt) {
      if (!Number.isFinite(dt) || dt <= 0 || (typeof document !== "undefined" && document.hidden)) {
        return;
      }
      const frameMs = dt * 1000;
      this.frameMsSmooth += (frameMs - this.frameMsSmooth) * 0.06;
      if (this.mode !== "magnetosphere") {
        this._slowRenderSeconds = 0;
        this._fastRenderSeconds = 0;
        return;
      }
      if (this.frameMsSmooth > 23.5) {
        this._slowRenderSeconds += dt;
        this._fastRenderSeconds = 0;
      } else if (this.frameMsSmooth < 17.2) {
        this._fastRenderSeconds += dt;
        this._slowRenderSeconds = Math.max(0, this._slowRenderSeconds - dt * 0.5);
      } else {
        this._slowRenderSeconds = Math.max(0, this._slowRenderSeconds - dt * 0.25);
        this._fastRenderSeconds = 0;
      }
      if (this._slowRenderSeconds > 1.8 && this.magQualityScale > 0.62) {
        this.magQualityScale = Math.max(0.62, this.magQualityScale - 0.12);
        this._slowRenderSeconds = 0;
        this._fastRenderSeconds = 0;
        this.qualityChanges++;
        this.resize();
      } else if (this._fastRenderSeconds > 8 && this.magQualityScale < 1) {
        this.magQualityScale = Math.min(1, this.magQualityScale + 0.08);
        this._slowRenderSeconds = 0;
        this._fastRenderSeconds = 0;
        this.qualityChanges++;
        this.resize();
      }
    }

    _initThree() {
      if (typeof THREE === "undefined") {
        console.error("Soundstage: THREE is missing");
        return;
      }
      this.renderer = new THREE.WebGLRenderer({
        canvas: this.canvas,
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: Boolean(this.options.preserveDrawingBuffer),
      });
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.info.autoReset = false;
      this.magPost = typeof SCVizMagnetospherePost !== "undefined"
        ? new SCVizMagnetospherePost(this.renderer)
        : null;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 260);
      this.camera.layers.enable(MAG_NO_REFLECT_LAYER);
      this.camera.layers.enable(MAG_VOID_LAYER);
      this.camera.position.set(0, 0.35, 7.2);
      this.bandData = new Uint8Array(32 * 4);
      this.bandTex = new THREE.DataTexture(this.bandData, 32, 1, THREE.RGBAFormat);
      this.bandTex.magFilter = THREE.LinearFilter;
      this.bandTex.minFilter = THREE.LinearFilter;
      this.bandTex.wrapS = THREE.ClampToEdgeWrapping;
      this.bandTex.needsUpdate = true;
      this.uniforms = {
        time: { value: 0 },
        audioLevel: { value: 0 },
        loudness: { value: 0 },
        loudGlow: { value: this.params.loudGlow },
        bloomSwirlAngle: { value: 0 },
        bass: { value: 0 },
        color: { value: new THREE.Color(1, 0.33, 0) },
        bands: { value: this.bandTex },
        bloomBright: { value: this.params.bloomBright },
        bloomSize: { value: this.params.bloomSize },
        bloomSpread: { value: this.params.bloomSpread },
        bloomShape: { value: this.params.bloomShape },
        bloomHue: { value: this.params.bloomHue },
        bloomWarm: { value: this.params.bloomWarm },
        bloomSpark: { value: this.params.bloomSpark },
        bloomSoft: { value: this.params.bloomSoft },
        bloomTight: { value: this.params.bloomTight },
        bloomReact: { value: 1 },
        bloomDance: { value: 0 },
        color2: { value: new THREE.Color(0.16, 0.55, 1) },
        color3: { value: new THREE.Color(1, 0.55, 0.18) },
        ridgeFreq: { value: this.params.ridgeFreq },
        ridgeFuzz: { value: this.params.ridgeFuzz },
        orbA: { value: new THREE.Vector3(1.6, 0, 0) },
        orbB: { value: new THREE.Vector3(-1.6, 0, 0) },
        couple: { value: 0.5 },
        magReflectivity: { value: 0 },
        magReflectionTex: { value: null },
        magVoidGlow: { value: this.params.magVoidGlow },
        magTrail: { value: this.params.magTrail },
        magAtmosphere: { value: this.params.magAtmosphere },
      };
      this.ridgeFog = new THREE.FogExp2(0x08141e, 0.015);
      this.pulse = this._makePulse();
      this.ridge = this._makeRidge();
      this.bloom = this._makeBloom();
      this.magnetosphere = this._makeMagnetosphere();
      this.dance = this._makeDance();
      this.scene.add(this.pulse, this.ridge, this.bloom, this.magnetosphere, this.dance);
      this.setMode(this.mode);
      this.resize();
    }

    _makePulse() {
      const group = new THREE.Group();
      const outerMat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        wireframe: true,
        transparent: true,
        depthWrite: true,
        side: THREE.DoubleSide,
        vertexShader: `
          uniform float time;
          uniform float audioLevel;
          uniform float bass;
          varying vec3 vNormal;
          varying vec3 vWorldPos;
          ${SNOISE}
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vec3 pos = position;
            float n = snoise(pos * 0.85 + vec3(0.0, time * 0.28, time * 0.12));
            float n2 = snoise(pos * 1.8 + vec3(time * 0.15));
            pos += normal * (n * 0.55 + n2 * 0.18) * (0.45 + audioLevel * 1.8 + bass * 0.8);
            vec4 world = modelMatrix * vec4(pos, 1.0);
            vWorldPos = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform float audioLevel;
          uniform float time;
          uniform float loudness;
          uniform float loudGlow;
          varying vec3 vNormal;
          varying vec3 vWorldPos;
          void main() {
            vec3 viewDir = normalize(cameraPosition - vWorldPos);
            float fresnel = 1.0 - max(0.0, dot(viewDir, normalize(vNormal)));
            fresnel = pow(fresnel, 1.6 + audioLevel * 2.2);
            float pulse = 0.75 + 0.25 * sin(time * 2.0);
            vec3 col = color * fresnel * pulse * (1.15 + audioLevel * 1.1);
            col += vec3(1.0) * fresnel * fresnel * 0.35;
            col *= 1.0 + loudness * loudGlow * 0.82;
            float alpha = fresnel * (0.55 + audioLevel * 0.35);
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      const outer = new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 4), outerMat);
      outer.renderOrder = 0;
      const glowMat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        side: THREE.BackSide,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          varying vec3 vNormal;
          varying vec3 vWorldPos;
          void main() {
            vNormal = normalize(normalMatrix * normal);
            vec4 world = modelMatrix * vec4(position, 1.0);
            vWorldPos = world.xyz;
            gl_Position = projectionMatrix * viewMatrix * world;
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform float audioLevel;
          uniform float loudness;
          uniform float loudGlow;
          varying vec3 vNormal;
          varying vec3 vWorldPos;
          void main() {
            vec3 viewDir = normalize(cameraPosition - vWorldPos);
            float fresnel = pow(1.0 - max(0.0, dot(viewDir, normalize(vNormal))), 3.0);
            float a = fresnel * (0.22 + audioLevel * 0.45);
            gl_FragColor = vec4(
              color * (1.2 + audioLevel) * (1.0 + loudness * loudGlow * 0.72),
              a
            );
          }
        `,
      });
      const glow = new THREE.Mesh(new THREE.SphereGeometry(1.95, 32, 32), glowMat);
      this.artMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.52,
        depthTest: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.artMesh = new THREE.Mesh(new THREE.CircleGeometry(0.82, 48), this.artMat);
      this.artMesh.renderOrder = 1;
      this.artMesh.visible = false;
      const count = 2200;
      const pPos = new Float32Array(count * 3);
      const pSize = new Float32Array(count);
      const pBand = new Float32Array(count);
      const pSeed = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const rad = 3.0 + Math.random() * 10;
        const a = Math.random() * Math.PI * 2;
        const y = (Math.random() - 0.5) * 6.5;
        pPos[i * 3] = Math.cos(a) * rad;
        pPos[i * 3 + 1] = y;
        pPos[i * 3 + 2] = Math.sin(a) * rad;
        pSize[i] = Math.pow(Math.random(), 2.5) * 3.8 + 0.15;
        pBand[i] = Math.min(1, Math.abs(y) / 3.2 * 0.45 + (rad - 3) / 12);
        pSeed[i] = Math.random();
      }
      const pGeo = new THREE.BufferGeometry();
      pGeo.setAttribute("position", new THREE.BufferAttribute(pPos, 3));
      pGeo.setAttribute("psize", new THREE.BufferAttribute(pSize, 1));
      pGeo.setAttribute("band", new THREE.BufferAttribute(pBand, 1));
      pGeo.setAttribute("seed", new THREE.BufferAttribute(pSeed, 1));
      const pMat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          attribute float psize;
          attribute float band;
          attribute float seed;
          uniform sampler2D bands;
          uniform float bass;
          uniform float audioLevel;
          varying float vGain;
          varying float vSeed;
          void main() {
            float g = texture2D(bands, vec2(band * 0.97 + 0.015, 0.5)).r;
            g = pow(g, 0.92);
            vGain = g;
            vSeed = seed;
            vec3 pos = position;
            pos *= 1.0 + g * 0.08 + bass * 0.04;
            vec4 mv = modelViewMatrix * vec4(pos, 1.0);
            gl_Position = projectionMatrix * mv;
            float dist = max(-mv.z, 0.6);
            gl_PointSize = psize * mix(5.0, 34.0, 0.15 + 0.85 * g) / dist;
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform float loudness;
          uniform float loudGlow;
          varying float vGain;
          varying float vSeed;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            if (max(abs(p.x), abs(p.y)) > 0.48) discard;
            float edge = 1.0 - smoothstep(0.38, 0.48, max(abs(p.x), abs(p.y)));
            float lit = 0.12 + vSeed * 0.08 + vGain * vGain * 1.35;
            float bright = 1.0 + loudness * loudGlow * 0.68;
            gl_FragColor = vec4(color * (0.55 + vGain * 1.6) * bright, edge * lit);
          }
        `,
      });
      this.pulseDust = new THREE.Points(pGeo, pMat);
      group.add(glow, outer, this.artMesh, this.pulseDust);
      return group;
    }

    _makeRidge() {
      const group = new THREE.Group();
      const positions = new Float32Array(RIDGE_ROWS * RIDGE_COLS * 3);
      const colors = new Float32Array(RIDGE_ROWS * RIDGE_COLS * 3);
      const index = [];
      for (let row = 0; row < RIDGE_ROWS; row++) {
        for (let col = 0; col < RIDGE_COLS; col++) {
          const i = row * RIDGE_COLS + col;
          positions[i * 3] = (col / (RIDGE_COLS - 1) - 0.5) * 18;
          positions[i * 3 + 1] = 0;
          positions[i * 3 + 2] = -row * 0.32;
          const fade = 1 - row / RIDGE_ROWS;
          colors[i * 3] = fade;
          colors[i * 3 + 1] = fade;
          colors[i * 3 + 2] = fade;
        }
        for (let col = 0; col < RIDGE_COLS - 1; col++) {
          const i = row * RIDGE_COLS + col;
          index.push(i, i + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      geo.setIndex(index);
      this.ridgeGeo = geo;
      this._ridgeStep = 1;
      this.ridgeMark = new Uint8Array(RIDGE_ROWS);
      this.ridgeMark[0] = 1;
      this._ridgeShiftCount = 0;
      this._syncRidgeIndex();
      this.ridgeLineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      group.add(new THREE.LineSegments(geo, this.ridgeLineMat));
      const frontPos = new Float32Array(RIDGE_COLS * 3);
      const frontGeo = new THREE.BufferGeometry();
      frontGeo.setAttribute("position", new THREE.BufferAttribute(frontPos, 3));
      const frontIndex = [];
      for (let col = 0; col < RIDGE_COLS - 1; col++) frontIndex.push(col, col + 1);
      frontGeo.setIndex(frontIndex);
      this.ridgeFrontGeo = frontGeo;
      this.ridgeFrontMat = new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      });
      this.ridgeFront = new THREE.LineSegments(frontGeo, this.ridgeFrontMat);
      this.ridgeFront.renderOrder = 2;
      group.add(this.ridgeFront);
      this.ridgeHalos = [];
      for (let i = 0; i < 16; i++) {
        const haloMat = this.ridgeLineMat.clone();
        haloMat.opacity = 0;
        const halo = new THREE.LineSegments(geo, haloMat);
        halo.visible = false;
        this.ridgeHalos.push(halo);
        group.add(halo);
      }
      group.add(this._makeRidgeGround());
      group.add(this._makeRidgeSky());
      group.add(this._makeRidgeHorizon());
      this.ridgeMotes = this._makeRidgeMotes();
      group.add(this.ridgeMotes);
      group.position.set(0, 0, 0);
      group.rotation.x = -0.22;
      return group;
    }

    _makeRidgeGround() {
      const mat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: `
          varying vec2 vUv;
          varying vec3 vPos;
          void main() {
            vUv = uv;
            vPos = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform float time;
          uniform float audioLevel;
          uniform float loudness;
          uniform float loudGlow;
          varying vec2 vUv;
          varying vec3 vPos;
          void main() {
            float depth = vUv.y;
            vec3 cool = mix(vec3(0.012, 0.03, 0.055), color, 0.16 + 0.08 * sin(time * 0.05));
            float gz = abs(fract(vPos.y * 0.14 + time * 0.01) - 0.5);
            float gx = abs(fract(vPos.x * 0.09) - 0.5);
            float lineZ = 1.0 - smoothstep(0.0, 0.028, gz);
            float lineX = 1.0 - smoothstep(0.0, 0.022, gx);
            lineX *= exp(-depth * 5.5);
            float grid = max(lineZ * 0.55, lineX * 0.35);
            grid *= (1.0 - smoothstep(0.2, 0.92, depth));
            float wash = 0.07 + depth * 0.16 + audioLevel * 0.04;
            float horizon = pow(smoothstep(0.62, 1.0, depth), 1.4);
            vec3 col = cool * wash + color * grid * 0.22 + color * horizon * 0.18;
            col *= 1.0 + loudness * loudGlow * 0.34;
            float alpha = 0.22 + grid * 0.28 + horizon * 0.2;
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(110, 150), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(0, -0.16, -52);
      return mesh;
    }

    _makeRidgeSky() {
      const mat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform float time;
          uniform float audioLevel;
          uniform float loudness;
          uniform float loudGlow;
          varying vec2 vUv;
          void main() {
            float h = vUv.y;
            vec3 zenith = vec3(0.008, 0.016, 0.03);
            vec3 belt = mix(vec3(0.03, 0.055, 0.09), color, 0.28 + 0.1 * sin(time * 0.06));
            float horz = pow(smoothstep(0.08, 0.42, h) * (1.0 - smoothstep(0.42, 0.78, h)), 1.1);
            vec3 col = mix(zenith, belt, horz);
            col += color * audioLevel * 0.04 * horz;
            col *= 1.0 + loudness * loudGlow * 0.28;
            float alpha = 0.42 + horz * 0.28;
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(180, 70), mat);
      mesh.position.set(0, 9.5, -86);
      mesh.rotation.x = -0.06;
      return mesh;
    }

    _makeRidgeHorizon() {
      const mat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        vertexShader: `
          varying vec2 vUv;
          void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform float audioLevel;
          uniform float loudness;
          uniform float loudGlow;
          varying vec2 vUv;
          void main() {
            float gx = 1.0 - pow(abs(vUv.x - 0.5) * 2.0, 1.6);
            float gy = exp(-pow((vUv.y - 0.5) * 7.5, 2.0));
            float glow = gx * gy;
            vec3 col = mix(color, vec3(0.75, 0.88, 1.0), 0.35);
            float bright = 1.0 + loudness * loudGlow * 0.7;
            gl_FragColor = vec4(
              col * (0.7 + audioLevel * 0.45) * bright,
              glow * (0.28 + audioLevel * 0.18)
            );
          }
        `,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(95, 11), mat);
      mesh.position.set(0, 2.1, -80);
      return mesh;
    }

    _makeRidgeMotes() {
      const count = 2200;
      const pos = new Float32Array(count * 3);
      const size = new Float32Array(count);
      const seed = new Float32Array(count);
      const band = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        const z = -Math.pow(Math.random(), 0.65) * 92;
        const span = 8 + Math.abs(z) * 0.28;
        pos[i * 3] = (Math.random() - 0.5) * span * 2.2;
        pos[i * 3 + 1] = 0.25 + Math.pow(Math.random(), 1.35) * (2.4 + Math.abs(z) * 0.045);
        pos[i * 3 + 2] = z;
        const far = Math.min(1, Math.abs(z) / 90);
        size[i] = (0.35 + 2.05 * Math.pow(Math.random(), 2.2)) * (0.55 + far * 1.1);
        seed[i] = Math.random();
        band[i] = far;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geo.setAttribute("psize", new THREE.BufferAttribute(size, 1));
      geo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
      geo.setAttribute("band", new THREE.BufferAttribute(band, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          attribute float psize;
          attribute float seed;
          attribute float band;
          uniform float time;
          uniform float audioLevel;
          varying float vAlpha;
          varying float vSeed;
          varying float vFar;
          void main() {
            vSeed = seed;
            vFar = band;
            vec3 pos = position;
            pos.x += sin(time * 0.07 + seed * 6.2) * (0.12 + band * 0.2);
            pos.y += sin(time * 0.055 + seed * 4.1) * 0.08;
            vec4 mv = modelViewMatrix * vec4(pos, 1.0);
            gl_Position = projectionMatrix * mv;
            float dist = max(-mv.z, 0.7);
            gl_PointSize = psize * mix(7.0, 18.0, band) * (0.85 + audioLevel * 0.25) / dist;
            vAlpha = mix(0.14, 0.055, band) * (0.7 + seed * 0.5);
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform float time;
          uniform float loudness;
          uniform float loudGlow;
          varying float vAlpha;
          varying float vSeed;
          varying float vFar;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            float d = length(p);
            if (d > 0.5) discard;
            float glow = pow(1.0 - d * 2.0, mix(1.35, 2.1, vFar));
            float twinkle = 0.75 + 0.25 * sin(time * (0.7 + vSeed * 1.8) + vSeed * 12.0);
            vec3 tint = mix(color, vec3(0.72, 0.86, 1.0), 0.25 + vFar * 0.4);
            float bright = 1.0 + loudness * loudGlow * 0.62;
            gl_FragColor = vec4(tint * twinkle * bright, glow * vAlpha * twinkle);
          }
        `,
      });
      return new THREE.Points(geo, mat);
    }

    _makeBloom() {
      const group = new THREE.Group();
      const positions = new Float32Array(BLOOM_COUNT * 3);
      const seeds = new Float32Array(BLOOM_COUNT);
      const bands = new Float32Array(BLOOM_COUNT);
      const sizes = new Float32Array(BLOOM_COUNT);
      // 1 = far-field orb: background, volumetric, largely exempt from the
      // shaping and swirl that the main cloud gets.
      const depths = new Float32Array(BLOOM_COUNT);
      // 1 = belongs to the outer disc and may shear. The central shell must
      // NOT: it is a 3D sphere, and shearing it by xz radius rotates its
      // latitude bands against each other, which looks like the core melting
      // rather than like rings orbiting.
      const rings = new Float32Array(BLOOM_COUNT);
      for (let i = 0; i < BLOOM_COUNT; i++) {
        const mode = Math.random();
        if (mode > 0.95) {
          // Sparse orbs scattered through the volume around the cloud, so the
          // empty regions read as space with things in it rather than as flat
          // black. Spherical, not a disc, so they sit at a spread of depths.
          const u2 = Math.random();
          const v2 = Math.random();
          const theta = 2 * Math.PI * u2;
          const phi = Math.acos(2 * v2 - 1);
          // The bloom camera flies THROUGH the cloud (z sweeps +-9.6), so a far
          // field reaching past that gets flown through: orbs sweep the lens
          // as enormous blobs. Kept inside the turning radius, and faded out
          // by distance below so approaching one dissolves it instead.
          const r = 3.4 + Math.pow(Math.random(), 0.7) * 5.6;
          positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
          positions[i * 3 + 1] = r * Math.cos(phi) * 0.8;
          positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
          bands[i] = Math.random();
          seeds[i] = Math.random();
          sizes[i] = 2.4 + Math.random() * 3.4;
          depths[i] = 1;
          rings[i] = 0.3; // background drifts a little, but is not a ring
          continue;
        }
        if (mode < 0.62) {
          const u = Math.random();
          const v = Math.random();
          const theta = 2 * Math.PI * u;
          const phi = Math.acos(2 * v - 1);
          const r = 2.1 + Math.random() * 0.15;
          positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
          positions[i * 3 + 1] = r * Math.cos(phi);
          positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
          bands[i] = Math.abs(Math.cos(phi));
        } else {
          const a = Math.random() * Math.PI * 2;
          const r = Math.pow(Math.random(), 0.45) * 5.5;
          positions[i * 3] = Math.cos(a) * r;
          positions[i * 3 + 1] = (Math.random() - 0.5) * 0.35;
          positions[i * 3 + 2] = Math.sin(a) * r;
          bands[i] = Math.min(1, r / 5.5);
          rings[i] = 1;
        }
        seeds[i] = Math.random();
        sizes[i] = Math.pow(Math.random(), 2.35) * 3.4 + 0.18;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
      geo.setAttribute("band", new THREE.BufferAttribute(bands, 1));
      geo.setAttribute("psize", new THREE.BufferAttribute(sizes, 1));
      geo.setAttribute("depth", new THREE.BufferAttribute(depths, 1));
      geo.setAttribute("ring", new THREE.BufferAttribute(rings, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          attribute float seed;
          attribute float band;
          attribute float psize;
          attribute float depth;
          attribute float ring;
          uniform float bass;
          uniform sampler2D bands;
          uniform float bloomSize;
          uniform float bloomSpread;
          uniform float bloomShape;
          uniform float bloomTight;
          uniform float bloomReact;
          uniform float bloomDance;
          uniform float bloomSwirlAngle;
          varying float vAlpha;
          varying float vGain;
          varying float vLive;
          varying float vBand;
          varying float vSeed;
          varying float vNearFade;
          varying float vDepth;
          void main() {
            vDepth = depth;
            float g = texture2D(bands, vec2(band * 0.97 + 0.015, 0.5)).r;
            g = pow(g, 0.95);
            float live = g * bloomReact;
            float motion = mix(live, bloomDance, 0.38);
            vGain = g;
            vLive = live;
            vBand = band;
            vSeed = seed;
            vec3 pos = position;
            // Differential rotation: the outer disc leads the inner shell.
            // Normalised against the original radius, not the scaled one, so
            // the profile does not change when bloomTight squeezes the cloud.
            // One shear per group, NOT a function of radius. Scaling by radius
            // makes the disc a continuum from the inner speed at its centre to
            // the outer speed at its rim -- so "outer stopped" only ever stops
            // the extreme rim. Worse, the accumulated angle is unbounded, so
            // neighbouring radii diverge without limit and the disc winds into
            // a spiral until it is azimuthally uniform. A uniform ring of dots
            // has no visible rotation, which is why it appeared to slow to a
            // halt over time and never recover.
            float shear = bloomSwirlAngle * ring;
            float cs = cos(shear);
            float sn = sin(shear);
            // Same handedness as Object3D.rotation.y, which is
            // [c 0 s / 0 1 0 / -s 0 c]. Rotating the other way makes the shear
            // SUBTRACT from the object rotation, so the disc's world rate
            // becomes base*(2*inner - outer): with inner at 2.5 the rings run
            // fastest at outer 0, look synchronised at 2.5, and stop dead at 5.
            pos.xz = vec2(pos.x * cs + pos.z * sn, -pos.x * sn + pos.z * cs);
            // The far field keeps its volume when the cloud flattens or tightens,
            // which is the whole point of it: depth the main body cannot give.
            pos *= mix(mix(1.42, 0.4, bloomTight), 1.2, depth);
            pos.y *= mix(mix(1.0, 0.1, bloomShape), 1.0, depth);
            pos.xz *= mix(mix(1.0, 1.0 + bloomShape * 0.42, bloomShape), 1.0, depth);
            float pulse = 1.0 + motion * bloomSpread * 0.22 * mix(1.0, 0.25, depth);
            vec4 mv = modelViewMatrix * vec4(pos * pulse, 1.0);
            gl_Position = projectionMatrix * mv;
            float dist = -mv.z;
            float size = psize * bloomSize * mix(32.0, 52.0, motion);
            gl_PointSize = min(mix(86.0, 44.0, depth), size / max(dist * 0.42, 0.65));
            // Far orbs need a much wider near-fade: they are large and soft, so
            // the camera reaches them long before the main cloud's 1.8 units.
            vNearFade = mix(smoothstep(0.48, 1.8, dist), smoothstep(1.7, 5.4, dist), depth);
            vAlpha = (0.3 + seed * 0.12 + live * 0.12) * vNearFade * mix(1.0, 0.42, depth);
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform vec3 color2;
          uniform vec3 color3;
          uniform float bloomBright;
          uniform float bloomHue;
          uniform float bloomWarm;
          uniform float bloomSpark;
          uniform float bloomSoft;
          uniform float bloomReact;
          uniform float time;
          uniform float loudness;
          uniform float loudGlow;
          varying float vAlpha;
          varying float vGain;
          varying float vLive;
          varying float vBand;
          varying float vSeed;
          varying float vNearFade;
          varying float vDepth;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            float d = length(p);
            if (d > 0.5) discard;
            float edge = 1.0 - smoothstep(0.42, 0.5, d);
            // Far orbs get a wider, coreless falloff so they read as soft
            // out-of-focus bodies rather than as more sparkle.
            float halo = exp(-d * d * mix(mix(15.0, 8.5, bloomSoft), 5.5, vDepth));
            float core = exp(-d * d * mix(mix(70.0, 38.0, bloomSoft), 14.0, vDepth));
            float glow = (halo * 0.38 + core * 0.72) * edge;
            float fan = clamp(bloomHue, 0.0, 1.0);
            float slot = fract(vBand * 0.7 + vSeed * fan * 0.95 + vGain * 0.08);
            vec3 cLow = mix(color, color3, 0.4 * fan);
            vec3 cMid = mix(color3, color, 0.2);
            vec3 cHigh = mix(color, color2, 0.5 + 0.5 * fan);
            vec3 themed = mix(cLow, cMid, smoothstep(0.0, 0.55, slot));
            themed = mix(themed, cHigh, smoothstep(0.38, 1.0, slot) * fan);
            themed = mix(color, themed, 0.22 + fan * 0.78);
            vec3 hot = mix(themed, vec3(1.0, 0.94, 0.8), bloomWarm * (0.12 + vLive * 0.22 + vBand * 0.12));
            float twinkle = 0.84 + 0.16 * sin(time * (1.2 + vSeed * 2.5) + vSeed * 18.0);
            float spark = mix(1.0, twinkle, bloomSpark * (0.38 + vLive * 0.35));
            float bright =
              bloomBright * (1.08 + vLive * 0.28) * spark *
              (1.0 + loudness * loudGlow * 0.92) * mix(1.0, 0.5, vDepth);
            float alpha = (halo * 0.22 + core * 0.58) * edge * vAlpha * vNearFade;
            gl_FragColor = vec4(hot * bright * (halo * 0.32 + core * 0.9), alpha);
          }
        `,
      });
      this.bloomPoints = new THREE.Points(geo, mat);
      group.add(this.bloomPoints);
      return group;
    }

    _makeDance() {
      const group = new THREE.Group();
      group.visible = false;
      // Lit rather than additive: these are solid bodies, and the whole point
      // is reading their silhouettes moving. Key light carries the accent
      // colour so they still respond to the music.
      const key = new THREE.DirectionalLight(0xffffff, 2.6);
      key.position.set(2.5, 4.5, 3);
      const rim = new THREE.DirectionalLight(0x88aaff, 1.5);
      rim.position.set(-3, 2, -3.5);
      const ambient = new THREE.HemisphereLight(0x445577, 0x080810, 0.7);
      group.add(key, rim, ambient);
      this.danceKey = key;
      this.danceRim = rim;

      // Backdrop. Without one the figures float in pure black with nothing to
      // stand on and no sense of depth or scale.
      const floor = new THREE.Mesh(
        new THREE.CircleGeometry(9, 64).rotateX(-Math.PI / 2),
        new THREE.ShaderMaterial({
          uniforms: this.uniforms,
          transparent: true,
          depthWrite: false,
          fragmentShader: `
            uniform vec3 color;
            uniform vec3 color2;
            uniform float loudness;
            uniform float loudGlow;
            varying vec2 vUv;
            void main() {
              vec2 p = vUv * 2.0 - 1.0;
              float d = length(p);
              // Concentric rings so the floor reads as a surface rather than a
              // flat wash, fading out well before the geometry edge.
              float rings = 0.5 + 0.5 * sin(d * 46.0);
              float fade = pow(1.0 - clamp(d, 0.0, 1.0), 2.4);
              vec3 c = mix(color2, color, 0.35 + rings * 0.3);
              float a = fade * (0.10 + rings * 0.05) * (1.0 + loudness * loudGlow * 0.5);
              gl_FragColor = vec4(c * (0.5 + rings * 0.5), a);
            }
          `,
          vertexShader: `
            varying vec2 vUv;
            void main() {
              vUv = uv;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
        })
      );
      floor.position.y = -0.95;
      group.add(floor);

      // Sparse haze behind and around them, so the space has depth.
      const N = 900;
      const pos = new Float32Array(N * 3);
      const seed = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const a = Math.random() * Math.PI * 2;
        const r = 4 + Math.pow(Math.random(), 0.55) * 16;
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = -0.9 + Math.pow(Math.random(), 1.7) * 9;
        pos[i * 3 + 2] = Math.sin(a) * r - 3;
        seed[i] = Math.random();
      }
      const hazeGeo = new THREE.BufferGeometry();
      hazeGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      hazeGeo.setAttribute("seed", new THREE.BufferAttribute(seed, 1));
      const haze = new THREE.Points(
        hazeGeo,
        new THREE.ShaderMaterial({
          uniforms: this.uniforms,
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          vertexShader: `
            attribute float seed;
            uniform float time;
            uniform float loudness;
            varying float vSeed;
            void main() {
              vSeed = seed;
              vec3 p = position;
              p.y += sin(time * (0.12 + seed * 0.2) + seed * 30.0) * 0.5;
              vec4 mv = modelViewMatrix * vec4(p, 1.0);
              gl_Position = projectionMatrix * mv;
              gl_PointSize = (5.0 + seed * 26.0) / max(-mv.z * 0.16, 0.5);
            }
          `,
          fragmentShader: `
            uniform vec3 color;
            uniform vec3 color2;
            uniform float loudness;
            uniform float loudGlow;
            varying float vSeed;
            void main() {
              float d = length(gl_PointCoord - 0.5);
              if (d > 0.5) discard;
              float g = exp(-d * d * 9.0) * (1.0 - smoothstep(0.42, 0.5, d));
              vec3 c = mix(color2, color, vSeed);
              float a = g * (0.05 + vSeed * 0.05) * (1.0 + loudness * loudGlow * 0.6);
              gl_FragColor = vec4(c * 0.9, a);
            }
          `,
        })
      );
      haze.frustumCulled = false;
      group.add(haze);
      this.danceHaze = haze;

      this.danceState = null;
      return group;
    }

    /**
     * Loads the shared rig once, then clones it per dancer. SkeletonUtils.clone
     * is required rather than Object3D.clone: the latter copies the meshes but
     * leaves them bound to the ORIGINAL skeleton, so every clone would move in
     * lockstep with the first.
     */
    _loadDancers() {
      if (this.danceState || this._danceLoading) return;
      const Loader = THREE.GLTFLoader;
      if (!Loader || !THREE.SkeletonUtils) {
        if (!this._warnedNoGltf) {
          this._warnedNoGltf = true;
          console.warn("Soundstage: three-addons.js not loaded; dance mode unavailable");
        }
        return;
      }
      // file:// blocks fetch() of local assets, so the page loads but the model
      // never arrives. Say so plainly instead of surfacing a bare CORS error --
      // every other mode works from file://, so this is a surprising failure.
      if (!this.options.assetUrl && location.protocol === "file:") {
        if (!this._warnedFileProtocol) {
          this._warnedFileProtocol = true;
          console.warn(
            "Soundstage: dance mode needs the lab served over http, not opened as a file.\n" +
              "  cd " + (location.pathname.replace(/\/[^/]*$/, "") || ".") + "\n" +
              "  python3 -m http.server 8765\n" +
              "  open http://127.0.0.1:8765/preview.html?mode=dance"
          );
        }
        return;
      }
      this._danceLoading = true;
      const url = this.options.assetUrl
        ? this.options.assetUrl("src/assets/RobotExpressive.glb")
        : "src/assets/RobotExpressive.glb";
      new Loader().load(
        url,
        (gltf) => {
          this._danceLoading = false;
          const clips = Object.fromEntries(gltf.animations.map((c) => [c.name, c]));
          // Derive the layout from the rig's real bounds. The model is ~6 units
          // tall and its origin sits ~0.93 above the soles, so hardcoding a
          // scale or a y offset puts the figures through the floor or out of
          // frame.
          gltf.scene.updateMatrixWorld(true);
          const box = new THREE.Box3().setFromObject(gltf.scene);
          const size = new THREE.Vector3();
          box.getSize(size);
          const unit = Math.max(0.001, size.y);
          const footDrop = -box.min.y / unit; // soles, as a fraction of height
          const GROUND = -0.95;
          const dancers = [];
          for (let i = 0; i < DANCERS; i++) {
            const root = THREE.SkeletonUtils.clone(gltf.scene);
            const a = (i / DANCERS) * Math.PI * 2;
            const ring = i === 0 ? 0 : 1.75 + (i % 2) * 0.42;
            const height = i === 0 ? 1.6 : 1.08 + (i % 3) * 0.1;
            const scale = height / unit;
            root.position.set(
              Math.sin(a) * ring,
              GROUND + footDrop * height,
              Math.cos(a) * ring * 0.72 - 0.35
            );
            // Face the camera, with a little splay so it is not a lineup.
            // The previous `-a + PI` turned everyone's back to the viewer.
            root.rotation.y = Math.sin(a) * 0.45;
            root.scale.setScalar(scale);
            root.traverse((o) => {
              if (o.isMesh) {
                o.castShadow = false;
                o.receiveShadow = false;
                // Skinned meshes carry bind-pose bounding volumes, and this rig
                // hangs its mesh under an armature scaled 100x -- so the culler
                // computes bounds that have nothing to do with where the figure
                // actually is and drops every dancer. Standard for characters.
                o.frustumCulled = false;
                if (o.material) o.material = o.material.clone();
              }
            });
            const mixer = new THREE.AnimationMixer(root);
            const danceClip = clips.Dance || gltf.animations[0];
            const action = mixer.clipAction(danceClip);
            action.play();
            action.paused = true;
            action.setEffectiveWeight(0);
            // Rest pose until a downbeat latches the crew onto the grid.
            const idle = clips.Idle ? mixer.clipAction(clips.Idle) : null;
            if (idle) {
              idle.play();
              idle.setEffectiveWeight(1);
            }
            // Variety without more clips: spread them across the 8-beat phrase
            // so they are on different steps of the same move, and mirror
            // every other one. Rate is shared; half-time desyncs the crew.
            const beatOffset = [0, 4, 2, 6, 1, 5, 3][i % 7];
            if (i % 2 === 1) root.scale.x *= -1;
            dancers.push({
              root, mixer, action, idle,
              baseScale: scale, baseY: root.position.y,
              beatOffset, mix: 0, accent: null, accentUntil: 0,
            });
            this.dance.add(root);
          }
          this.danceState = {
            clips, dancers,
            clipDuration: (clips.Dance || gltf.animations[0]).duration,
            latched: false, nextAccent: 0, turn: 0,
          };
        },
        undefined,
        (err) => {
          this._danceLoading = false;
          console.warn(`Soundstage: dance model failed to load from ${url}`, err);
        }
      );
    }

    _tickDance(dt) {
      const st = this.danceState;
      if (!st) return;
      const m = this.motion;
      const step = Math.min(dt, 0.1);
      const [r, g, b] = this.liveAccent;
      const now = this.elapsed;
      const period = this.bpm > 0 ? 60 / this.bpm : 0;
      const locked = m.gridMix > 0.35 && period > 0 && m.live > 0.45;
      const clipBeat = st.clipDuration / DANCE_CLIP_BEATS;

      if (this.danceKey) {
        this.danceKey.intensity = 1.9 + m.loudness * 1.2;
        this.danceKey.color.setRGB(
          0.55 + (r / 255) * 0.45,
          0.55 + (g / 255) * 0.45,
          0.55 + (b / 255) * 0.45
        );
      }
      if (this.danceRim) this.danceRim.intensity = 0.9 + m.loudness * 0.7;

      // Motion is latched on the downbeat, then left alone. Per-frame phase
      // locking, BPM-chasing timeScale, and kick/accent bounces are what made
      // the footwork skittish -- every tempo nudge and onset became a twitch.
      if (!locked) st.latched = false;
      if (this.downbeatHit && locked) {
        const rate = clipBeat / period;
        const beatsBase = (this.barIndex * 4) % DANCE_CLIP_BEATS;
        for (const d of st.dancers) {
          d.action.paused = false;
          d.action.timeScale = rate;
          d.action.time =
            (((beatsBase + d.beatOffset) % DANCE_CLIP_BEATS) / DANCE_CLIP_BEATS) *
            st.clipDuration;
        }
        st.latched = true;

        if (now > st.nextAccent && DANCE_ACCENTS.length) {
          const d = st.dancers[st.turn % st.dancers.length];
          st.turn++;
          const name = DANCE_ACCENTS[(st.turn * 3) % DANCE_ACCENTS.length];
          const clip = st.clips?.[name];
          if (clip && !d.accent) {
            const act = d.mixer.clipAction(clip);
            act.reset();
            act.setLoop(THREE.LoopOnce, 1);
            act.clampWhenFinished = true;
            act.timeScale = rate;
            act.play();
            d.accent = act;
            d.accentUntil = now + (clip.duration / Math.max(0.2, rate)) * 0.92;
          }
          st.nextAccent = now + period * 8;
        }
      }

      const dancing = st.latched && locked ? 1 : 0;
      for (const d of st.dancers) {
        if (d.accent && now > d.accentUntil) {
          d.accent.fadeOut(0.25);
          d.accent = null;
        }
        d.mix += (dancing - d.mix) * (1 - Math.exp(-step / (dancing ? 0.12 : 0.28)));
        const accentWeight = d.accent ? 1 : 0;
        d.action.setEffectiveWeight(d.mix * (1 - accentWeight));
        if (d.idle) d.idle.setEffectiveWeight((1 - d.mix) * (1 - accentWeight));
        if (d.accent) d.accent.setEffectiveWeight(1);
        if (!st.latched) d.action.paused = true;
        d.root.scale.setScalar(d.baseScale);
        d.root.position.y = d.baseY;
        d.mixer.update(step);
      }
    }

    _magRandom() {
      let x = this.magSeed | 0;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.magSeed = x >>> 0;
      return this.magSeed / 4294967296;
    }

    _makeMagnetosphere() {
      const group = new THREE.Group();
      this.magnetosphereMid = new THREE.Vector3();
      this.mag = {
        orbs: [],
        particles: [],
        palette: [new THREE.Color(), new THREE.Color(), new THREE.Color()],
        paletteTarget: [new THREE.Color(), new THREE.Color(), new THREE.Color()],
        flowVelocity: Array.from({ length: MAG_ATTRACTORS }, () => new THREE.Vector3()),
        flowCount: new Uint16Array(MAG_ATTRACTORS),
        flareEvents: [],
        center: new THREE.Vector3(),
        centerVelocity: new THREE.Vector3(),
        tmp: new THREE.Vector3(),
        radial: new THREE.Vector3(),
        tangent: new THREE.Vector3(),
        axis: new THREE.Vector3(),
        trailTangent: new THREE.Vector3(),
        trailView: new THREE.Vector3(),
        trailSide: new THREE.Vector3(),
        ringN: new THREE.Vector3(),
        ringB: new THREE.Vector3(),
        pulse: 0,
        pulseTarget: 0,
        yaw: 0.35,
        preset: -1,
        trailAcc: 0,
        simAcc: 0,
        geometryReady: false,
        geometryBuilds: 0,
        simulationTime: 0,
        cameraLocked: false,
        density: 1,
      };
      const coreGeometry = new THREE.SphereGeometry(MAG_CORE_RADIUS, 48, 36);
      const makeOrb = (index) => {
        const orb = new THREE.Group();
        const coreMaterial = new THREE.ShaderMaterial({
          uniforms: this.uniforms,
          depthTest: true,
          depthWrite: true,
          toneMapped: false,
          vertexShader: `
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            varying vec4 vClipPos;
            void main() {
              vNormal = normalize(mat3(modelMatrix) * normal);
              vec4 world = modelMatrix * vec4(position, 1.0);
              vWorldPos = world.xyz;
              vClipPos = projectionMatrix * viewMatrix * world;
              gl_Position = vClipPos;
            }
          `,
          fragmentShader: `
            uniform vec3 color;
            uniform vec3 color2;
            uniform vec3 color3;
            uniform float time;
            uniform float loudness;
            uniform float loudGlow;
            uniform float magReflectivity;
            uniform sampler2D magReflectionTex;
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            varying vec4 vClipPos;
            void main() {
              vec3 n = normalize(vNormal);
              vec3 viewDir = normalize(cameraPosition - vWorldPos);
              vec3 reflected = reflect(-viewDir, n);
              float fresnel = pow(1.0 - max(0.0, dot(n, viewDir)), 2.2);
              vec2 screenUv = vClipPos.xy / max(vClipPos.w, 0.0001) * 0.5 + 0.5;
              vec2 warp = (n.xy * 0.075 + reflected.xy * 0.035) * (0.45 + fresnel);
              vec3 liveReflection = texture2D(
                magReflectionTex,
                clamp(screenUv + warp, vec2(0.002), vec2(0.998))
              ).rgb;
              float sweep = 0.5 + 0.5 * sin(
                reflected.y * 7.5 + reflected.x * 3.2 + reflected.z * 1.7 + time * 0.11
              );
              float environment = pow(smoothstep(0.48, 0.94, sweep), 3.5);
              float polar = pow(max(0.0, reflected.y * 0.62 + 0.38), 6.0);
              vec3 lightDir = normalize(vec3(-0.38, 0.76, 0.53));
              vec3 halfDir = normalize(lightDir + viewDir);
              float specular = pow(max(0.0, dot(n, halfDir)), 104.0);
              vec3 tint = mix(color2, color3, 0.5 + 0.5 * reflected.x);
              tint = mix(tint, color, polar * 0.55);
              vec3 reflection = liveReflection * (0.72 + fresnel * 1.15);
              reflection += tint * environment * 0.055;
              reflection += mix(tint, vec3(0.92, 0.97, 1.0), 0.72) * polar * 0.07;
              reflection += vec3(1.0, 0.97, 0.9) * specular * 0.7;
              float loud = 1.0 + loudness * loudGlow * 0.72;
              gl_FragColor = vec4(reflection * magReflectivity * loud, 1.0);
            }
          `,
        });
        const core = new THREE.Mesh(coreGeometry, coreMaterial);
        core.layers.set(MAG_VOID_LAYER);
        core.renderOrder = -10;
        const haloMaterial = new THREE.ShaderMaterial({
          uniforms: this.uniforms,
          side: THREE.BackSide,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          toneMapped: false,
          vertexShader: `
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            void main() {
              vNormal = normalize(mat3(modelMatrix) * normal);
              vec4 world = modelMatrix * vec4(position, 1.0);
              vWorldPos = world.xyz;
              gl_Position = projectionMatrix * viewMatrix * world;
            }
          `,
          fragmentShader: `
            uniform vec3 color2;
            uniform vec3 color3;
            uniform float time;
            uniform float loudness;
            uniform float loudGlow;
            uniform float magVoidGlow;
            varying vec3 vNormal;
            varying vec3 vWorldPos;
            void main() {
              vec3 viewDir = normalize(cameraPosition - vWorldPos);
              float rim = pow(1.0 - abs(dot(normalize(vNormal), viewDir)), 2.8);
              float drift = 0.82 + 0.18 * sin(time * 0.17 + vWorldPos.y * 2.4);
              float strength = magVoidGlow * rim * drift * (1.0 + loudness * loudGlow * 0.28);
              vec3 tint = mix(color2, color3, 0.42 + 0.16 * sin(time * 0.07));
              gl_FragColor = vec4(tint * 0.34, strength * 0.28);
            }
          `,
        });
        const halo = new THREE.Mesh(coreGeometry, haloMaterial);
        halo.layers.set(MAG_NO_REFLECT_LAYER);
        halo.scale.setScalar(1.095);
        halo.renderOrder = -11;
        orb.add(halo, core);
        orb.userData.core = core;
        orb.userData.halo = halo;
        orb.userData.coreMaterial = coreMaterial;
        orb.userData.index = index;
        return orb;
      };

      const orbScales = [1.0, 0.72, 0.58, 0.44, 0.34];
      for (let i = 0; i < MAG_ATTRACTORS; i++) {
        const mesh = makeOrb(i);
        const phase = i * 2.3999632297 + 0.35;
        const orbit = i === 0 ? 0.72 : 1.65 + i * 0.54;
        const initial = new THREE.Vector3(
          Math.cos(phase) * orbit,
          Math.sin(phase * 1.37) * (0.55 + i * 0.16),
          Math.sin(phase) * orbit * (0.44 + i * 0.06)
        );
        const baseCharge = i % 2 ? -1 : 1;
        const body = {
          p: initial.clone(),
          prev: initial.clone(),
          v: new THREE.Vector3(
            (this._magRandom() - 0.5) * 0.18,
            (this._magRandom() - 0.5) * 0.18,
            (this._magRandom() - 0.5) * 0.18
          ),
          target: initial.clone(),
          axis: new THREE.Vector3(
            this._magRandom() - 0.5,
            0.4 + this._magRandom() * 0.8,
            this._magRandom() - 0.5
          ).normalize(),
          mesh,
          phase,
          charge: baseCharge,
          chargeStrength: baseCharge,
          bandSmooth: 0,
          kickEnvelope: 0,
          visualScale: orbScales[i] * 0.9,
          orbit,
          scale: orbScales[i],
          band: i / Math.max(1, MAG_ATTRACTORS - 1),
        };
        mesh.position.copy(initial);
        this.mag.orbs.push(body);
        group.add(mesh);
      }

      const trailVerts = MAG_PARTICLES * (MAG_TRAIL - 1) * 2;
      const trailPos = new Float32Array(trailVerts * 3);
      const trailCol = new Float32Array(trailVerts * 3);
      const trailAlpha = new Float32Array(trailVerts);
      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute("position", new THREE.BufferAttribute(trailPos, 3));
      lineGeo.setAttribute("color", new THREE.BufferAttribute(trailCol, 3));
      lineGeo.setAttribute("alpha", new THREE.BufferAttribute(trailAlpha, 1));
      this.magLinePos = lineGeo.attributes.position;
      this.magLineCol = lineGeo.attributes.color;
      this.magLineAlpha = lineGeo.attributes.alpha;
      this.magnetosphereLines = new THREE.LineSegments(
        lineGeo,
        new THREE.ShaderMaterial({
          uniforms: this.uniforms,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          vertexColors: true,
          vertexShader: `
            attribute float alpha;
            varying vec3 vColor;
            varying float vAlpha;
            void main() {
              vColor = color;
              vAlpha = alpha;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform float loudness;
            uniform float loudGlow;
            uniform float magTrail;
            varying vec3 vColor;
            varying float vAlpha;
            void main() {
              float bright = magTrail * (1.0 + loudness * loudGlow * 0.82);
              gl_FragColor = vec4(vColor * (0.8 + vAlpha * 0.75) * bright, vAlpha * magTrail);
            }
          `,
        })
      );
      this.magnetosphereLines.frustumCulled = false;

      const headPos = new Float32Array(MAG_PARTICLES * 3);
      const headCol = new Float32Array(MAG_PARTICLES * 3);
      const headSize = new Float32Array(MAG_PARTICLES);
      const headLife = new Float32Array(MAG_PARTICLES);
      const headGeo = new THREE.BufferGeometry();
      headGeo.setAttribute("position", new THREE.BufferAttribute(headPos, 3));
      headGeo.setAttribute("color", new THREE.BufferAttribute(headCol, 3));
      headGeo.setAttribute("psize", new THREE.BufferAttribute(headSize, 1));
      headGeo.setAttribute("life", new THREE.BufferAttribute(headLife, 1));
      this.magHeadPos = headGeo.attributes.position;
      this.magHeadCol = headGeo.attributes.color;
      this.magHeadSize = headGeo.attributes.psize;
      this.magHeadLife = headGeo.attributes.life;
      const headMat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexColors: true,
        vertexShader: `
          attribute float psize;
          attribute float life;
          varying vec3 vColor;
          varying float vLife;
          void main() {
            vColor = color;
            vLife = life;
            vec4 mv = modelViewMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = psize * 12.0 / max(-mv.z, 0.75);
          }
        `,
        fragmentShader: `
          uniform float loudness;
          uniform float loudGlow;
          varying vec3 vColor;
          varying float vLife;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            float d = length(p);
            if (d > 0.5) discard;
            float halo = exp(-d * d * 11.0);
            float glow = exp(-d * d * 34.0);
            float core = 1.0 - smoothstep(0.0, 0.065, d);
            float rayX = exp(-abs(p.x) * 54.0) * exp(-abs(p.y) * 4.0);
            float rayY = exp(-abs(p.y) * 54.0) * exp(-abs(p.x) * 4.0);
            float star = (rayX + rayY) * 0.18;
            float a = (halo * 0.28 + glow * 0.62 + core + star) * vLife;
            vec3 hot = mix(vColor, vec3(1.0, 0.97, 0.9), core * 0.82 + star * 0.3);
            float bright = 1.0 + loudness * loudGlow;
            gl_FragColor = vec4(hot * (0.72 + glow * 0.8 + core * 2.6 + star) * bright, a);
          }
        `,
      });
      this.magnetosphereRays = new THREE.Points(headGeo, headMat);
      this.magnetosphereRays.frustumCulled = false;

      const ribbonVerts = MAG_RIBBONS * MAG_TRAIL * 2;
      const ribbonPos = new Float32Array(ribbonVerts * 3);
      const ribbonCol = new Float32Array(ribbonVerts * 3);
      const ribbonAlpha = new Float32Array(ribbonVerts);
      const ribbonIndex = [];
      for (let r = 0; r < MAG_RIBBONS; r++) {
        const base = r * MAG_TRAIL * 2;
        for (let s = 0; s < MAG_TRAIL - 1; s++) {
          const o = base + s * 2;
          ribbonIndex.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
        }
      }
      const ribbonGeo = new THREE.BufferGeometry();
      ribbonGeo.setAttribute("position", new THREE.BufferAttribute(ribbonPos, 3));
      ribbonGeo.setAttribute("color", new THREE.BufferAttribute(ribbonCol, 3));
      ribbonGeo.setAttribute("alpha", new THREE.BufferAttribute(ribbonAlpha, 1));
      ribbonGeo.setIndex(ribbonIndex);
      this.magRibbonPos = ribbonGeo.attributes.position;
      this.magRibbonCol = ribbonGeo.attributes.color;
      this.magRibbonAlpha = ribbonGeo.attributes.alpha;
      this.magnetosphereRibbons = new THREE.Mesh(
        ribbonGeo,
        new THREE.ShaderMaterial({
          uniforms: this.uniforms,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          depthTest: true,
          vertexColors: true,
          side: THREE.DoubleSide,
          vertexShader: `
            attribute float alpha;
            varying vec3 vColor;
            varying float vAlpha;
            void main() {
              vColor = color;
              vAlpha = alpha;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform float loudness;
            uniform float loudGlow;
            varying vec3 vColor;
            varying float vAlpha;
            void main() {
              float edge = 0.7 + vAlpha * 0.6;
              float bright = 1.0 + loudness * loudGlow * 0.7;
              gl_FragColor = vec4(vColor * edge * bright, vAlpha);
            }
          `,
        })
      );
      this.magnetosphereRibbons.frustumCulled = false;

      const spikeGeo = new THREE.BufferGeometry();
      spikeGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(MAG_SPIKES * 2 * 3), 3)
      );
      spikeGeo.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(MAG_SPIKES * 2 * 3), 3)
      );
      spikeGeo.setAttribute(
        "alpha",
        new THREE.BufferAttribute(new Float32Array(MAG_SPIKES * 2), 1)
      );
      this.magSpikePos = spikeGeo.attributes.position;
      this.magSpikeCol = spikeGeo.attributes.color;
      this.magSpikeAlpha = spikeGeo.attributes.alpha;
      this.magnetosphereSpikes = new THREE.LineSegments(
        spikeGeo,
        this.magnetosphereLines.material
      );
      this.magnetosphereSpikes.frustumCulled = false;

      const ringVerts = MAG_ATTRACTORS * MAG_RINGS_PER_ORB * MAG_RING_SEGS * 2;
      const ringGeo = new THREE.BufferGeometry();
      ringGeo.setAttribute(
        "position",
        new THREE.BufferAttribute(new Float32Array(ringVerts * 3), 3)
      );
      ringGeo.setAttribute(
        "color",
        new THREE.BufferAttribute(new Float32Array(ringVerts * 3), 3)
      );
      ringGeo.setAttribute(
        "alpha",
        new THREE.BufferAttribute(new Float32Array(ringVerts), 1)
      );
      this.magRingPos = ringGeo.attributes.position;
      this.magRingCol = ringGeo.attributes.color;
      this.magRingAlpha = ringGeo.attributes.alpha;
      this.magnetosphereRings = new THREE.LineSegments(
        ringGeo,
        this.magnetosphereLines.material
      );
      this.magnetosphereRings.layers.set(MAG_NO_REFLECT_LAYER);
      this.magnetosphereRings.frustumCulled = false;

      const flareCount = 20;
      const flarePos = new Float32Array(flareCount * 3);
      const flareCol = new Float32Array(flareCount * 3);
      const flareSize = new Float32Array(flareCount);
      const flareLife = new Float32Array(flareCount);
      const flareGeo = new THREE.BufferGeometry();
      flareGeo.setAttribute("position", new THREE.BufferAttribute(flarePos, 3));
      flareGeo.setAttribute("color", new THREE.BufferAttribute(flareCol, 3));
      flareGeo.setAttribute("psize", new THREE.BufferAttribute(flareSize, 1));
      flareGeo.setAttribute("life", new THREE.BufferAttribute(flareLife, 1));
      this.magFlarePos = flareGeo.attributes.position;
      this.magFlareCol = flareGeo.attributes.color;
      this.magFlareSize = flareGeo.attributes.psize;
      this.magFlareLife = flareGeo.attributes.life;
      this.magnetosphereFlares = new THREE.Points(flareGeo, headMat);
      this.magnetosphereFlares.frustumCulled = false;

      for (let i = 0; i < MAG_PARTICLES; i++) {
        const particle = {
          p: new THREE.Vector3(),
          v: new THREE.Vector3(),
          trail: new Float32Array(MAG_TRAIL * 3),
          ribbonSide: new Float32Array(MAG_TRAIL * 3),
          band: Math.pow(this._magRandom(), 1.7),
          charge: this._magRandom() < 0.5 ? -1 : 1,
          chargeTarget: 1,
          home: i % MAG_ATTRACTORS,
          age: 0,
          life: 4,
          seed: this._magRandom(),
          size: 0.6,
          impactCooldown: 0,
        };
        this.mag.particles.push(particle);
        this._resetMagParticle(particle, true);
      }

      const nebCount = MAG_NEBULA;
      const nebPos = new Float32Array(nebCount * 3);
      const nebSeed = new Float32Array(nebCount);
      for (let i = 0; i < nebCount; i++) {
        const r = 3.5 + Math.pow(this._magRandom(), 0.45) * 14;
        const a = this._magRandom() * Math.PI * 2;
        const y = (this._magRandom() - 0.5) * 10.5;
        nebPos[i * 3] = Math.cos(a) * r;
        nebPos[i * 3 + 1] = y;
        nebPos[i * 3 + 2] = Math.sin(a) * r;
        nebSeed[i] = this._magRandom();
      }
      const nebGeo = new THREE.BufferGeometry();
      nebGeo.setAttribute("position", new THREE.BufferAttribute(nebPos, 3));
      nebGeo.setAttribute("seed", new THREE.BufferAttribute(nebSeed, 1));
      const nebMat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          attribute float seed;
          uniform float time;
          uniform float audioLevel;
          varying float vAlpha;
          varying float vSeed;
          ${SNOISE}
          void main() {
            vSeed = seed;
            vec3 pos = position;
            float n = snoise(pos * 0.14 + vec3(0.0, time * 0.018, time * 0.014));
            pos += vec3(n, snoise(pos * 0.12 + 9.0 + time * 0.016), n * 0.35) * 1.15;
            vec4 mv = modelViewMatrix * vec4(pos, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = (1.4 + seed * 4.8) * (0.85 + audioLevel * 0.45) / max(-mv.z * 0.13, 0.65);
            vAlpha = 0.08 + seed * 0.16 + audioLevel * 0.08;
          }
        `,
        fragmentShader: `
          uniform vec3 color;
          uniform vec3 color2;
          uniform float time;
          uniform float loudness;
          uniform float loudGlow;
          uniform float magAtmosphere;
          varying float vAlpha;
          varying float vSeed;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            float d = length(p);
            if (d > 0.5) discard;
            float glow = pow(1.0 - d * 2.0, 1.85);
            vec3 tint = mix(color, color2, 0.42 + 0.34 * sin(time * 0.035 + vSeed * 5.0));
            float bright = magAtmosphere * (1.0 + loudness * loudGlow * 0.42);
            gl_FragColor = vec4(tint * 0.52 * bright, glow * vAlpha * magAtmosphere);
          }
        `,
      });
      this.magnetosphereNebula = new THREE.Points(nebGeo, nebMat);

      const atmo = new THREE.Mesh(
        new THREE.SphereGeometry(15, 36, 24),
        new THREE.ShaderMaterial({
          uniforms: this.uniforms,
          side: THREE.BackSide,
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          vertexShader: `
            varying vec3 vWorldPos;
            void main() {
              vec4 world = modelMatrix * vec4(position, 1.0);
              vWorldPos = world.xyz;
              gl_Position = projectionMatrix * viewMatrix * world;
            }
          `,
          fragmentShader: `
            uniform vec3 color;
            uniform vec3 color2;
            uniform vec3 color3;
            uniform float time;
            uniform float audioLevel;
            uniform float loudness;
            uniform float loudGlow;
            uniform float magAtmosphere;
            varying vec3 vWorldPos;
            ${SNOISE}
            void main() {
              vec3 ray = normalize(vWorldPos - cameraPosition);
              vec3 drift = vec3(time * 0.018, -time * 0.011, time * 0.014);
              float density = 0.0;
              float colorNoise = 0.0;
              for (int i = 0; i < 5; i++) {
                float fi = float(i);
                vec3 samplePos = cameraPosition * 0.14 + ray * (2.0 + fi * 2.15) + drift;
                float broad = snoise(samplePos * 0.31 + fi * 1.73);
                float detail = snoise(samplePos * 0.72 - drift * 1.4 + fi * 3.1);
                float cloud = smoothstep(0.03, 0.72, broad * 0.72 + detail * 0.28);
                density += cloud * (0.29 - fi * 0.028);
                colorNoise += detail * 0.08;
              }
              float horizon = 1.0 - smoothstep(0.22, 0.92, abs(ray.y));
              density *= 0.7 + horizon * 0.45;
              vec3 cool = mix(color2, color3, 0.24 + colorNoise);
              vec3 tint = mix(color * 0.72, cool, 0.34 + horizon * 0.16);
              float bright = magAtmosphere * (1.0 + loudness * loudGlow * 0.38);
              float alpha = density * (0.035 + audioLevel * 0.014) * magAtmosphere;
              gl_FragColor = vec4(tint * (0.22 + density * 0.16) * bright, alpha);
            }
          `,
        })
      );
      this.magnetosphereAtmo = atmo;

      group.add(
        atmo,
        this.magnetosphereNebula,
        this.magnetosphereRings,
        this.magnetosphereRibbons,
        this.magnetosphereSpikes,
        this.magnetosphereRays,
        this.magnetosphereFlares,
        this.magnetosphereLines
      );
      group.visible = false;
      return group;
    }

    _tick(dt) {
      this._updatePerformance(dt);
      this._analyse(dt);
      // Drain onsets that fired since the last render.
      const pending = this._pendingHit;
      this.hit.low = pending.low;
      this.hit.mid = pending.mid;
      this.hit.high = pending.high;
      pending.low = pending.mid = pending.high = 0;
      this.beatHit = this._pendingBeat;
      this.downbeatHit = this._pendingDownbeat;
      this._pendingBeat = false;
      this._pendingDownbeat = false;
      // The beat clock only runs on the analysis clock, so extrapolate phase
      // to the render instant. Without this the primary motion quantises to
      // the hop grid and re-introduces exactly the stutter P0 removed.
      // Only extrapolate while the clock is actually locked. Free-running the
      // phase against a stale bpm keeps manufacturing beats after playback has
      // stopped, which is the visuals bouncing to nothing.
      if (this.engineDriven && this.beatLocked && this.bpm > 0) {
        const period = 60 / this.bpm;
        this.beatPhase += dt / period;
        while (this.beatPhase >= 1) this.beatPhase -= 1;
        this.barPhase += dt / (period * 4);
        while (this.barPhase >= 1) this.barPhase -= 1;
        this.phrasePhase += dt / (period * 32);
        while (this.phrasePhase >= 1) this.phrasePhase -= 1;
        this.timeToNextBeat = Math.max(0, this.timeToNextBeat - dt);
      }
      this.elapsed += dt;
      this._updateLiveColor();
      if (this.uniforms) {
        this.uniforms.time.value = this.elapsed;
        this.uniforms.audioLevel.value = this.energy;
        this.uniforms.loudness.value = this.motion.loudness;
        this.uniforms.bass.value = this.smoothBass;
      }
      this._updateMotion(dt);
      if (this.mode === "pulse" || this.mode === "bloom" || this.mode === "magnetosphere") {
        this._updateBands(dt);
      }
      if (this.mode === "pulse") this._tickPulse(dt);
      if (this.mode === "ridge") this._tickRidge(dt);
      if (this.mode === "bloom") this._tickBloom(dt);
      if (this.mode === "magnetosphere") this._tickMagnetosphere(dt);
      if (this.mode === "dance") this._tickDance(dt);
      this._updateCamera(dt);
      if (this.mode === "pulse") this._updatePulseArtwork();
      if (this.renderer) {
        this.renderer.info.reset();
        if (this.mode === "magnetosphere" && this.magPost) {
          const preset = Math.max(0, this.mag?.preset || 0);
          const bloom = [1.32, 1.08, 0.92, 1.24][preset] || 1.18;
          const exposure = [1.08, 0.98, 1.04, 1.12][preset] || 1.05;
          const loudBoost = this.motion.loudness * this.params.loudGlow;
          this.uniforms.magReflectionTex.value = this.magPost.reflectionTarget?.texture || null;
          this.magPost.render(this.scene, this.camera, {
            time: this.elapsed,
            threshold: preset === 2 ? 0.9 : 0.72,
            knee: 0.46,
            bloomStrength:
              (bloom + this.motion.accent * 0.20) * this.params.magBloom * (1 + loudBoost * 0.52),
            exposure:
              exposure + this.energy * 0.06 + this.motion.accent * 0.05 + loudBoost * 0.18,
            saturation: preset === 2 ? 1.02 : 1.12,
            // Kernel radii, not blur widths: width comes from how far down the
            // mip pyramid each band is taken. Anything much past 1.5 starts
            // undersampling the kernel again.
            fineRadius: 1.1,
            mediumRadius: preset === 3 ? 1.35 : 1.15,
            veilRadius: preset === 2 ? 1.2 : 1.4,
            voidLayer: MAG_VOID_LAYER,
          });
        } else {
          this.renderer.setRenderTarget(null);
          this.renderer.render(this.scene, this.camera);
        }
      }
      this._drawWaveform();
      this.onRender?.(dt);
    }

    _initMotion() {
      const M = globalThis.ScvizMotion;
      if (!M) {
        if (!this._warnedNoMotion) {
          this._warnedNoMotion = true;
          console.warn("Soundstage: motion.js not loaded; visuals stay level-driven");
        }
        return null;
      }
      if (!this._springs) {
        this._springs = {
          // Frequencies set the character: a kick should bloom and settle, a
          // hat should tick. Damping under 1 gives the overshoot that reads as
          // follow-through.
          kick: new M.Spring(3.0, 0.52),
          snare: new M.Spring(5.5, 0.7),
          hat: new M.Spring(9.5, 0.85),
          spin: new M.Spring(0.9, 0.72),
          downbeat: new M.Spring(1.5, 0.6),
        };
        // Slow both ways on purpose: the grid crossfade must never flicker,
        // or the whole scene changes character mid-phrase.
        this._gridMixEnv = new M.Envelope(1.2, 3.0);
        this._activityEnv = new M.Envelope(0.3, 2.6);
        this._beatEnv = new M.Envelope(0.005, 0.12);
        // Quick to trust, quick to drop.
        this._liveEnv = new M.Envelope(0.12, 0.22);
      }
      return M;
    }

    /**
     * Turn the analysis into motion, once per frame, before any mode runs.
     *
     * `gridMix` crossfades between reactive envelopes and the beat grid, so
     * material the clock cannot track degrades to the old behaviour instead of
     * looking wrong. Bar and phrase arcs additionally require the downbeat to
     * be trustworthy -- on four-on-the-floor it usually is not, and a bar
     * accent placed on the wrong beat is worse than none.
     */
    _updateMotion(dt) {
      const M = this._initMotion();
      const m = this.motion;
      if (!M) {
        m.loudness = this.loudness;
        m.live = 1;
        return;
      }
      const sp = this._springs;
      const step = dt > 0 ? Math.min(dt, 0.1) : 1 / 60;

      // Is there audio at all? The beat clock's phase free-runs by design, so
      // without an explicit signal gate a pause leaves the grid firing beats
      // into silence for as long as the confidence crossfade takes to release
      // -- several seconds of bouncing with nothing playing.
      m.live = this._liveEnv.push(M.smoothstep(0.012, 0.05, this.loudness), step);
      const grid = this.engineDriven ? M.smoothstep(0.35, 0.7, this.beatConfidence) : 0;
      m.gridMix = this._gridMixEnv.push(grid, step) * m.live;
      const barTrust = m.gridMix * M.smoothstep(0.15, 0.5, this.downbeatConfidence);

      // Amplitude comes from the onset envelope, timing from `hit`: a hit's
      // own strength under-reads when an attack straddles an analysis hop.
      const lowAmp = Math.max(this.hit.low, this.onset.low);
      if (this.hit.low > 0) {
        // Weight by surprisal so the fortieth kick of a section does not get
        // the same shove as the first one after a breakdown.
        const bite = 0.55 + 0.45 * Math.min(1.8, this.surprise.low);
        sp.kick.impulse(3.6 * lowAmp * bite);
      }
      if (this.hit.mid > 0) sp.snare.impulse(4.0 * Math.max(this.hit.mid, this.onset.mid));
      if (this.hit.high > 0) sp.hat.impulse(3.2 * Math.max(this.hit.high, this.onset.high));

      if (this.beatHit) {
        m.beatAmp += (Math.max(0.3, lowAmp) - m.beatAmp) * 0.35;
        sp.spin.impulse(0.7 * (0.4 + 0.6 * m.beatAmp) * m.gridMix);
      } else if (this.hit.low > 0) {
        sp.spin.impulse(0.5 * lowAmp * (1 - m.gridMix));
      }
      if (this.downbeatHit) sp.downbeat.impulse(2.4 * barTrust);

      // Sensitivity applies once, here, so it reaches every mode. It used to
      // be read only by _tickRidge and _tickBloom, which meant the slider did
      // nothing at all in pulse, magnetosphere or dance. At 1.0 this is the
      // identity, so nothing is retuned; those two modes simply weight it
      // twice at the extremes, which is the direction you would want anyway.
      const sens = clamp(this.params.sensitivity ?? 1, 0, 2.2);
      m.sensitivity = sens;

      m.kick = sp.kick.update(step) * sens;
      m.snare = sp.snare.update(step) * sens;
      m.hat = sp.hat.update(step) * sens;
      m.spin = sp.spin.update(step);
      m.downbeat = sp.downbeat.update(step);

      // The primary pulse: an anticipation swell that arrives ON the beat,
      // plus the hit itself as a triggered envelope.
      //
      // The hit deliberately is NOT a peak in a curve over phase. Such a peak
      // is sampled wherever the frame happens to fall, so the identical beat
      // renders at 0.66 on a 30 fps machine and 0.85 on a 90 fps one. A held
      // envelope presents its full height on whichever frame the beat lands.
      // Decay before triggering, or slow frames shave the top off.
      const period = this.bpm > 0 ? 60 / this.bpm : 0.5;
      this._beatEnv.release = Math.max(0.05, period * 0.2);
      this._beatEnv.decay(step);
      // Fire on the frame NEAREST the beat, not the first one after it.
      // Detecting the plain wrap makes every hit up to a whole frame late, so
      // a 30 fps machine sits a systematic ~16 ms behind a 90 fps one -- the
      // same lateness this whole design exists to remove, reintroduced at the
      // very last step. Advancing the phase by half a frame before looking for
      // the wrap centres the error at zero instead.
      let shifted = this.beatPhase + step / (2 * period);
      shifted -= Math.floor(shifted);
      const fire = this._prevShifted !== undefined && shifted < this._prevShifted;
      this._prevShifted = shifted;
      const beatSize = 0.55 + 0.45 * m.beatAmp;
      if (fire && m.gridMix > 0.02) this._beatEnv.trigger(beatSize);

      // Swelling into a beat that nothing supports feels arbitrary -- the
      // anticipation is a promise, and it should not be made when onsets have
      // stopped arriving. Fades out between roughly one and three beats of
      // silence from the kick stream.
      const beatMs = period * 1000;
      const supported = M.smoothstep(2.6 * beatMs, 0.9 * beatMs, this.since.low);
      const swell = M.swell(this.beatPhase, 0.28) * 0.46 * beatSize * supported;
      const gridAccent = Math.max(swell, this._beatEnv.value);
      m.accent = (this.kick + (gridAccent - this.kick) * m.gridMix) * m.live * sens;
      m.anticipation = m.gridMix * M.swell(this.beatPhase, 0.28) * supported;

      m.bar = M.archShape(this.barPhase, 2.2) * barTrust;
      m.phrase = M.archShape(this.phrasePhase, 2.4) * barTrust;

      // Stillness budget: sync is only legible against things that are not
      // moving, so ornament motion backs off when the music is busy.
      const busy = Math.max(this.onset.low, this.onset.mid, this.onset.high, this.loudness * 0.8);
      m.calm = 1 - Math.min(1, this._activityEnv.push(busy, step));

      // Loudness re-scaled against the range it has actually occupied over the
      // last several seconds.
      //
      // The raw signal is AGC-normalised RMS, so on real music it parks near a
      // constant -- which turns every `1.0 + loudness * loudGlow` term in the
      // shaders into a fixed brightness offset instead of a response. The
      // colour just sits brighter and never moves. Tracking a decaying peak
      // and valley recovers whatever dynamics the passage actually has.
      const L = this.loudness;
      const settle = Math.exp(-step / BEAT_LOUD_MEMORY);
      this._loudMax = Math.max(L, (this._loudMax ?? L) * settle + L * (1 - settle));
      this._loudMin = Math.min(L, (this._loudMin ?? L) * settle + L * (1 - settle));
      const range = this._loudMax - this._loudMin;
      const norm = M.clamp((L - this._loudMin) / Math.max(range, 1e-4), 0, 1);
      // A genuinely steady passage has no dynamics to expand; sit mid-scale
      // rather than amplifying noise into a flicker.
      const trust = M.smoothstep(0.03, 0.12, range);
      const dyn = 0.45 + (norm - 0.45) * trust;
      // Centred near where the old constant sat, so the average look is kept
      // and what changes is how far it swings.
      m.loudness = M.clamp(0.15 + dyn * 0.75, 0, 1.2);
    }

    _syncPulseArt() {
      if (!this.artMesh) return;
      this.artMesh.visible =
        this.mode === "pulse" && this.params.pulseArt >= 0.5 && Boolean(this.artMat?.map);
    }

    _tickPulse(dt) {
      const m = this.motion || {};
      const loud = Number.isFinite(m.loudness) ? m.loudness : (this.loudness || 0);
      const glow = loud * (this.params.loudGlow ?? 1);
      // Loudness is the body of the track. Kick/snare springs and the beat
      // accent made this orb jump on every onset -- the look before that
      // round, minus putting bass into spin rate (which drifted forever).
      this._pulseSpin = (this._pulseSpin || 0) + dt * 0.12;
      this.pulse.rotation.y = this._pulseSpin;
      this.pulse.rotation.x = Math.sin(this.elapsed * 0.35) * 0.12;
      this.pulse.scale.setScalar(1 + loud * 0.12 + glow * 0.04);
      // Shared uniforms otherwise carry hop-rate energy/bass, which wriggles
      // the wireframe every analysis frame. Loudness is already smoothed.
      if (this.uniforms) {
        this.uniforms.audioLevel.value = loud;
        this.uniforms.bass.value = loud;
      }
      this._syncPulseArt();
      if (this.artMesh) {
        const targetScale = 1 + loud * 0.10 + glow * 0.04;
        const k = 1 - Math.exp(-Math.max(0, dt) / 0.09);
        this._artScale = (this._artScale ?? 1) + (targetScale - (this._artScale ?? 1)) * k;
        this.artMesh.scale.setScalar(this._artScale);
        this.artMat.opacity = 0.48 + Math.min(0.13, glow * 0.09);
      }
      if (this.pulseDust) this.pulseDust.rotation.y -= dt * 0.04;
    }

    _updatePulseArtwork() {
      if (!this.artMesh || !this.pulse || !this.camera) return;
      this._pulseParentQuat ||= new THREE.Quaternion();
      this._pulseCameraQuat ||= new THREE.Quaternion();
      this.pulse.updateWorldMatrix(true, false);
      this.camera.updateWorldMatrix(true, false);
      this.pulse.getWorldQuaternion(this._pulseParentQuat);
      this.camera.getWorldQuaternion(this._pulseCameraQuat);
      this.artMesh.quaternion
        .copy(this._pulseParentQuat)
        .invert()
        .multiply(this._pulseCameraQuat);
    }

    _tickRidge(dt) {
      this._syncRidgeHalo();
      const pos = this.ridgeGeo.attributes.position;
      const col = this.ridgeGeo.attributes.color;
      const arr = pos.array;
      const carr = col.array;
      const mark = this.ridgeMark;
      const [r, g, b] = this.liveAccent;
      const fuzz = clamp(this.params.ridgeFuzz ?? 0.28, 0, 1);
      const loudBright = 1 + this.motion.loudness * this.params.loudGlow * 0.55;
      const freq = this.params.ridgeFreq ?? 1;
      const step = Math.max(1, Math.round(1 + (1 - freq) * 5));
      this._ridgeStep = step;
      // Lock the scroll rate to the beat, and re-anchor the accumulator on each
      // beat so rows stay phase-aligned rather than merely the right speed.
      const m = this.motion;
      let stepSecs = RIDGE_STEP;
      if (m.gridMix > 0.02 && this.bpm > 0) {
        const perBeat = 60 / this.bpm / RIDGE_ROWS_PER_BEAT;
        stepSecs = RIDGE_STEP + (perBeat - RIDGE_STEP) * m.gridMix;
      }
      if (this.beatHit && m.gridMix > 0.5) this.ridgeAcc = 0;
      this.ridgeAcc += dt;
      let shifted = false;
      while (this.ridgeAcc >= stepSecs) {
        this.ridgeAcc -= stepSecs;
        shifted = true;
        this._ridgeShiftCount++;
        if (this._ridgeShiftCount % step !== 0) mark[0] = 0;
        for (let row = RIDGE_ROWS - 1; row >= 1; row--) {
          const dst = row * RIDGE_COLS;
          const src = (row - 1) * RIDGE_COLS;
          for (let c = 0; c < RIDGE_COLS; c++) {
            arr[(dst + c) * 3 + 1] = arr[(src + c) * 3 + 1];
          }
          mark[row] = mark[row - 1];
        }
      }
      const sense = clamp(this.params.sensitivity ?? 1, 0, 2.2);
      const react = Math.min(1, sense);
      for (let c = 0; c < RIDGE_COLS; c++) {
        const raw = this._bandMag(c / (RIDGE_COLS - 1));
        const hgt =
          raw * (1.75 + react * 0.3 + m.accent * 0.42 * react) * this.params.ridgeHeight;
        arr[c * 3 + 1] = hgt;
      }
      mark[0] = 1;
      if (shifted) this._syncRidgeIndex();
      let recency = 0;
      const fadeK = 0.5 - fuzz * 0.28;
      const fadeFloor = 0.05 + fuzz * 0.09;
      const whiteK = 1.2 - fuzz * 0.45;
      for (let row = 0; row < RIDGE_ROWS; row++) {
        const drawn = mark[row];
        const age = drawn ? recency : 0;
        if (drawn) recency++;
        const white = drawn ? Math.exp(-age * whiteK) : 0;
        const fade = drawn ? fadeFloor + 1.15 * Math.exp(-age * fadeK) : 0;
        const tail = age === 0 ? 1 : 1 - fuzz * 0.22;
        const shade = fade * loudBright * tail;
        const wr = white + (r / 255) * (1 - white);
        const wg = white + (g / 255) * (1 - white);
        const wb = white + (b / 255) * (1 - white);
        const hot = age === 0 ? 2.2 : 1;
        for (let c = 0; c < RIDGE_COLS; c++) {
          const i = (row * RIDGE_COLS + c) * 3;
          carr[i] = drawn ? wr * shade * hot : 0;
          carr[i + 1] = drawn ? wg * shade * hot : 0;
          carr[i + 2] = drawn ? wb * shade * hot : 0;
        }
      }
      if (this.ridgeFrontGeo) {
        const front = this.ridgeFrontGeo.attributes.position.array;
        for (let c = 0; c < RIDGE_COLS; c++) {
          const i = c * 3;
          front[i] = arr[i];
          front[i + 1] = arr[i + 1];
          front[i + 2] = arr[i + 2];
        }
        this.ridgeFrontGeo.attributes.position.needsUpdate = true;
        if (this.ridgeFrontMat) {
          this.ridgeFrontMat.color.setRGB(
            Math.min(1, 0.82 + (r / 255) * 0.18),
            Math.min(1, 0.82 + (g / 255) * 0.18),
            Math.min(1, 0.82 + (b / 255) * 0.18)
          );
          this.ridgeFrontMat.opacity = 0.9;
        }
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }

    _syncRidgeIndex() {
      if (!this.ridgeGeo || !this.ridgeMark) return;
      const mark = this.ridgeMark;
      const index = [];
      for (let row = 0; row < RIDGE_ROWS; row++) {
        if (!mark[row]) continue;
        for (let col = 0; col < RIDGE_COLS - 1; col++) {
          const i = row * RIDGE_COLS + col;
          index.push(i, i + 1);
        }
      }
      this.ridgeGeo.setIndex(index);
    }

    _syncRidgeHalo() {
      const f = clamp(this.params.ridgeFuzz ?? 0.28, 0, 1);
      if (this.ridgeLineMat) this.ridgeLineMat.opacity = 1;
      const halos = this.ridgeHalos || [];
      const glowPairs = f < 0.03 ? 0 : Math.max(1, Math.round(1 + f * 7));
      const glowHalf = 0.014 + f * 0.16;
      const energy = (0.14 * f * (1 - f * 0.7)) / Math.max(glowPairs, 1);
      for (let i = 0; i < halos.length; i++) {
        const halo = halos[i];
        const ring = (i >> 1) + 1;
        const sign = i & 1 ? -1 : 1;
        const on = ring <= glowPairs;
        halo.visible = on;
        if (!on) {
          halo.material.opacity = 0;
          halo.position.set(0, 0, 0);
          continue;
        }
        const u = ring / glowPairs;
        halo.position.set(0, sign * glowHalf * u, 0.006 * ring);
        halo.material.opacity = energy * Math.exp(-u * u * 2.8);
        halo.material.color.setRGB(0.55, 0.6, 0.72);
      }
    }

    _tickMagnetosphere(dt) {
      const mag = this.mag;
      if (!mag) return;
      // Core size breathes rather than sitting at whatever the knob says. Two
      // incommensurate LFOs so it never settles into an audible loop, plus a
      // phrase-scale term when the clock is confident -- the form should move
      // with the music's structure, not only with a timer. Computed before the
      // fixed-step gate below so it tracks wall time even on skipped steps.
      const ct = this.elapsed;
      const cm = this.motion;
      const coreLfo =
        1 + Math.sin(ct * 0.117 + 0.7) * 0.10 + Math.sin(ct * 0.041 + 2.3) * 0.06;
      const corePhrase = 1 + (cm.phrase - 0.5) * 0.12 * cm.gridMix;
      this.magCoreScale = clamp(
        (this.params.magCoreSize ?? 1) * coreLfo * corePhrase,
        0.45,
        1.95
      );
      mag.simAcc = Math.min(MAG_SIM_STEP * 2, mag.simAcc + Math.min(0.05, dt));
      if (mag.simAcc + 1e-6 < MAG_SIM_STEP) return;
      mag.simAcc -= MAG_SIM_STEP;
      this._stepMagnetosphere(MAG_SIM_STEP);
    }

    _stepMagnetosphere(dt) {
      const mag = this.mag;
      if (!mag) return;
      const t = this.elapsed;
      const step = Math.min(0.025, dt);
      const simStep = this.magOptions.freeze ? 0 : step * this.params.magMotion;
      mag.simulationTime += simStep;
      const simT = mag.simulationTime;
      // Driven by the kick spring and the downbeat, plus the anticipation ramp
      // so the field starts to bloom before the beat rather than after it.
      const mo = this.motion;
      const drive = Math.max(0, mo.kick) * 0.55 + mo.downbeat * 0.30 + mo.anticipation * 0.12;
      // Shared with _stepMagnetosphere, which charges each orb from the same
      // impulse rather than from a level derivative of its own.
      mag.drive = drive;
      mag.pulseTarget = Math.max(drive, mag.pulseTarget * Math.exp(-step * 9.5));
      const pulseRate = mag.pulseTarget > mag.pulse ? 28 : 7;
      mag.pulse +=
        (mag.pulseTarget - mag.pulse) * (1 - Math.exp(-step * pulseRate));
      this.magReflectivity = clamp(this.params.magReflect, 0, 1);
      this.uniforms.magReflectivity.value = this.magReflectivity;
      const densityWave =
        0.5 +
        0.31 * Math.sin(t * 0.047 - 0.9) +
        0.19 * Math.sin(t * 0.019 + 1.6);
      const densityTarget = clamp(
        this.params.magDensity *
          (1 - this.params.magDensityAuto * (0.68 - clamp(densityWave, 0, 1) * 0.68)) +
          this.loudness * this.params.magDensityAuto * 0.07,
        0.08,
        1
      );
      mag.density += (densityTarget - mag.density) * (1 - Math.exp(-step * 0.75));
      const preset = this.magOptions.forcedPreset == null
        ? Math.floor(t / 30) % 4
        : ((this.magOptions.forcedPreset % 4) + 4) % 4;
      if (preset !== mag.preset) {
        mag.preset = preset;
        const hairCounts = [MAG_PARTICLES, 620, MAG_PARTICLES, 820];
        const ribbonCounts = [54, 24, 12, MAG_RIBBONS];
        const spikeCounts = [72, 36, MAG_SPIKES, 118];
        this.magnetosphereLines.geometry.setDrawRange(
          0,
          hairCounts[preset] * (MAG_TRAIL - 1) * 2
        );
        this.magnetosphereRibbons.geometry.setDrawRange(
          0,
          ribbonCounts[preset] * (MAG_TRAIL - 1) * 6
        );
        this.magnetosphereSpikes.geometry.setDrawRange(0, spikeCounts[preset] * 2);
        this.magnetosphereRings.visible = preset !== 2;
        const wireframe = preset === 2;
        if (this.magnetosphereRibbons.material.wireframe !== wireframe) {
          this.magnetosphereRibbons.material.wireframe = wireframe;
          this.magnetosphereRibbons.material.needsUpdate = true;
        }
        this.magnetosphereAtmo.visible = preset !== 2;
      }

      if (simStep > 0) {
        const tx = Math.sin(simT * 0.071) * 0.72 + Math.sin(simT * 0.023 + 1.7) * 0.24;
        const ty = Math.sin(simT * 0.047 + 1.2) * 0.48;
        const tz = Math.sin(simT * 0.031 + 2.1) * 0.56;
        mag.centerVelocity.x += (tx - mag.center.x) * simStep * 0.24;
        mag.centerVelocity.y += (ty - mag.center.y) * simStep * 0.24;
        mag.centerVelocity.z += (tz - mag.center.z) * simStep * 0.24;
        mag.centerVelocity.multiplyScalar(Math.exp(-simStep * 0.72));
        mag.center.addScaledVector(mag.centerVelocity, simStep);
      }

      for (let i = 0; i < mag.orbs.length; i++) {
        mag.orbs[i].mesh.visible = magOrbShown(preset, i);
      }

      for (let i = 0; i < mag.orbs.length; i++) {
        const orb = mag.orbs[i];
        orb.prev.copy(orb.p);
        const a = orb.phase + simT * (0.075 + i * 0.009);
        const breathe = 1 + 0.16 * Math.sin(simT * (0.17 + i * 0.013) + orb.phase);
        if (i === 0) {
          orb.target.set(
            mag.center.x + Math.sin(t * 0.13) * 0.55,
            mag.center.y + Math.cos(t * 0.11) * 0.42,
            mag.center.z + Math.sin(t * 0.09 + 1.0) * 0.42
          );
        } else {
          orb.target.set(
            mag.center.x + Math.cos(a) * orb.orbit * breathe,
            mag.center.y + Math.sin(a * 1.37 + orb.phase) * (0.62 + i * 0.18),
            mag.center.z + Math.sin(a) * orb.orbit * (0.46 + i * 0.065)
          );
        }
        const bandTarget = this._bandMag(orb.band);
        const bandRate = bandTarget > orb.bandSmooth ? 22 : 6.5;
        orb.bandSmooth +=
          (bandTarget - orb.bandSmooth) * (1 - Math.exp(-step * bandRate));
        const band = orb.bandSmooth;
        orb.kickEnvelope = Math.max(
          mag.drive || 0,
          orb.kickEnvelope * Math.exp(-step * 11)
        );
        const targetCharge = orb.charge * (0.68 + band * 0.78 + mag.pulse * 0.24);
        orb.chargeStrength += (targetCharge - orb.chargeStrength) * (1 - Math.exp(-step * 2.2));
        if (simStep > 0) {
          const spring = i === 0 ? 0.48 : 0.31;
          let ax = (orb.target.x - orb.p.x) * spring;
          let ay = (orb.target.y - orb.p.y) * spring;
          let az = (orb.target.z - orb.p.z) * spring;
          const ra = MAG_CORE_RADIUS * orb.visualScale;
          for (let j = 0; j < mag.orbs.length; j++) {
            if (j === i) continue;
            const other = mag.orbs[j];
            if (!orb.mesh.visible || !other.mesh.visible) continue;
            const dx = orb.p.x - other.p.x;
            const dy = orb.p.y - other.p.y;
            const dz = orb.p.z - other.p.z;
            const d2 = dx * dx + dy * dy + dz * dz;
            if (d2 < 1e-8) {
              ax += 0.4;
              continue;
            }
            const d = Math.sqrt(d2);
            const minD = ra + MAG_CORE_RADIUS * other.visualScale + 0.12;
            const reach = minD * 2.1;
            if (d >= reach) continue;
            const falloff = 1 - d / reach;
            const repel = (2.4 * falloff * falloff) / Math.max(d, 0.08);
            ax += (dx / d) * repel;
            ay += (dy / d) * repel;
            az += (dz / d) * repel;
          }
          ax += Math.sin(simT * 0.31 + orb.phase) * band * 0.15;
          ay += Math.cos(simT * 0.27 + orb.phase) * band * 0.12;
          az += Math.sin(simT * 0.23 - orb.phase) * band * 0.14;
          orb.v.x += ax * simStep;
          orb.v.y += ay * simStep;
          orb.v.z += az * simStep;
          if (orb.kickEnvelope > 0.01) {
            orb.v.addScaledVector(
              orb.axis,
              orb.kickEnvelope * (3.4 + i * 0.35) * simStep * (i % 2 ? -1 : 1)
            );
          }
          orb.v.multiplyScalar(Math.exp(-simStep * 0.72));
          if (orb.v.lengthSq() > 1.69) orb.v.setLength(1.3);
          orb.p.addScaledVector(orb.v, simStep);
        }
        const scaleTarget =
          orb.scale * this.magCoreScale * (0.9 + band * 0.24 + mag.pulse * 0.11);
        const scaleRate = scaleTarget > orb.visualScale ? 20 : 7.5;
        orb.visualScale +=
          (scaleTarget - orb.visualScale) * (1 - Math.exp(-step * scaleRate));
        orb.mesh.scale.setScalar(orb.visualScale);
        orb.mesh.rotation.y += step * (0.08 + i * 0.025);
        orb.mesh.rotation.x = Math.sin(t * 0.09 + orb.phase) * 0.18;
      }
      if (simStep > 0) this._separateMagOrbs();
      for (let i = 0; i < mag.orbs.length; i++) {
        mag.orbs[i].mesh.position.copy(mag.orbs[i].p);
      }

      this.magnetosphereMid.lerp(mag.center, 1 - Math.exp(-step * 1.7));
      mag.trailAcc += step;
      const sampleTrail = mag.trailAcc >= 1 / 45;
      if (sampleTrail) mag.trailAcc %= 1 / 45;
      if (simStep > 0) this._updateMagParticles(simStep, sampleTrail);
      this._updateMagRings();
      this.magnetosphereNebula.rotation.y += step * 0.009;
      this.magnetosphereNebula.rotation.x = Math.sin(t * 0.018) * 0.08;
      this.magnetosphereAtmo.rotation.y += step * 0.006;
      this.magnetosphereAtmo.rotation.z = Math.sin(t * 0.012) * 0.1;
    }

    _separateMagOrbs() {
      const orbs = this.mag?.orbs;
      if (!orbs) return;
      for (let i = 0; i < orbs.length; i++) {
        const a = orbs[i];
        if (!a.mesh.visible) continue;
        const ra = MAG_CORE_RADIUS * a.visualScale;
        for (let j = i + 1; j < orbs.length; j++) {
          const b = orbs[j];
          if (!b.mesh.visible) continue;
          const rb = MAG_CORE_RADIUS * b.visualScale;
          let dx = a.p.x - b.p.x;
          let dy = a.p.y - b.p.y;
          let dz = a.p.z - b.p.z;
          let d2 = dx * dx + dy * dy + dz * dz;
          const minD = ra + rb + 0.1;
          if (d2 < 1e-8) {
            dx = 0.04;
            dy = 0;
            dz = 0;
            d2 = dx * dx;
          }
          if (d2 >= minD * minD) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const ny = dy / d;
          const nz = dz / d;
          const overlap = minD - d;
          const wa = rb / Math.max(ra + rb, 0.001);
          const wb = 1 - wa;
          a.p.x += nx * overlap * wa;
          a.p.y += ny * overlap * wa;
          a.p.z += nz * overlap * wa;
          b.p.x -= nx * overlap * wb;
          b.p.y -= ny * overlap * wb;
          b.p.z -= nz * overlap * wb;
          const vn = (a.v.x - b.v.x) * nx + (a.v.y - b.v.y) * ny + (a.v.z - b.v.z) * nz;
          if (vn >= 0) continue;
          const impulse = -(1.45) * vn;
          a.v.x += nx * impulse * wa;
          a.v.y += ny * impulse * wa;
          a.v.z += nz * impulse * wa;
          b.v.x -= nx * impulse * wb;
          b.v.y -= ny * impulse * wb;
          b.v.z -= nz * impulse * wb;
        }
      }
    }

    _writeMagRing(orb, axis, radius, spin, tint, vertex, alphaValue) {
      const mag = this.mag;
      mag.tmp.set(0, 1, 0);
      mag.ringN.crossVectors(axis, mag.tmp);
      if (mag.ringN.lengthSq() < 0.001) {
        mag.tmp.set(1, 0, 0);
        mag.ringN.crossVectors(axis, mag.tmp);
      }
      mag.ringN.normalize();
      mag.ringB.crossVectors(axis, mag.ringN).normalize();
      const pos = this.magRingPos.array;
      const col = this.magRingCol.array;
      const alpha = this.magRingAlpha.array;
      for (let s = 0; s < MAG_RING_SEGS; s++) {
        for (let end = 0; end < 2; end++) {
          const u = (s + end) / MAG_RING_SEGS;
          const angle = u * Math.PI * 2 + spin;
          const ca = Math.cos(angle);
          const sa = Math.sin(angle);
          const o = vertex * 3;
          pos[o] = orb.p.x + (mag.ringN.x * ca + mag.ringB.x * sa) * radius;
          pos[o + 1] = orb.p.y + (mag.ringN.y * ca + mag.ringB.y * sa) * radius;
          pos[o + 2] = orb.p.z + (mag.ringN.z * ca + mag.ringB.z * sa) * radius;
          col[o] = tint.r;
          col[o + 1] = tint.g;
          col[o + 2] = tint.b;
          alpha[vertex] = alphaValue;
          vertex++;
        }
      }
      return vertex;
    }

    _updateMagRings() {
      if (!this.magRingPos || !this.mag) return;
      const mag = this.mag;
      const pos = this.magRingPos.array;
      const alpha = this.magRingAlpha.array;
      let vertex = 0;
      const glow = 0.11 + this.energy * 0.1;
      for (let i = 0; i < mag.orbs.length; i++) {
        const orb = mag.orbs[i];
        if (!orb.mesh.visible) continue;
        const tint = mag.palette[i % 3];
        const coreR = MAG_CORE_RADIUS * orb.visualScale;
        const spin = this.elapsed * (0.22 + i * 0.05);
        mag.axis.copy(orb.axis);
        if (mag.axis.lengthSq() < 1e-6) mag.axis.set(0, 1, 0);
        mag.axis.normalize();
        const yaw = this.elapsed * (0.13 + i * 0.03);
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const ax = mag.axis.x;
        const az = mag.axis.z;
        mag.axis.set(ax * cy - az * sy, mag.axis.y, ax * sy + az * cy).normalize();
        vertex = this._writeMagRing(orb, mag.axis, coreR * 1.22, spin, tint, vertex, glow);
        mag.tmp.set(1, 0, 0);
        if (Math.abs(mag.axis.dot(mag.tmp)) > 0.92) mag.tmp.set(0, 0, 1);
        mag.radial.copy(mag.axis).addScaledVector(mag.tmp, 0.62).normalize();
        vertex = this._writeMagRing(
          orb,
          mag.radial,
          coreR * 1.48,
          -spin * 0.7,
          tint,
          vertex,
          glow * 0.72
        );
      }
      for (let v = vertex; v < pos.length / 3; v++) {
        pos[v * 3] = 0;
        pos[v * 3 + 1] = 0;
        pos[v * 3 + 2] = 0;
        alpha[v] = 0;
      }
      this.magnetosphereRings.geometry.setDrawRange(0, vertex);
      this.magRingPos.needsUpdate = true;
      this.magRingCol.needsUpdate = true;
      this.magRingAlpha.needsUpdate = true;
    }

    _resetMagParticle(particle, initial = false) {
      const mag = this.mag;
      if (!mag?.orbs?.length) return;
      particle.home = (this._magRandom() * mag.orbs.length) | 0;
      const sign = this._magRandom() < 0.52 ? -1 : 1;
      particle.charge = sign * (0.28 + this._magRandom() * 0.72);
      particle.chargeTarget = particle.charge;
      particle.band = Math.pow(this._magRandom(), 1.55);
      particle.seed = this._magRandom();
      particle.age = initial ? this._magRandom() * 3.5 : 0;
      particle.life = 5.8 + this._magRandom() * 10.5;
      particle.size = 0.7 + Math.pow(this._magRandom(), 2.7) * 4.8;
      particle.impactCooldown = 0.2 + this._magRandom() * 0.5;
      const home = mag.orbs[particle.home];
      const z = this._magRandom() * 2 - 1;
      const a = this._magRandom() * Math.PI * 2;
      const rr = Math.sqrt(Math.max(0, 1 - z * z));
      mag.radial.set(Math.cos(a) * rr, z, Math.sin(a) * rr);
      const shell =
        0.42 + home.scale * this.magCoreScale * (0.38 + this._magRandom() * 0.46);
      particle.p.copy(home.p).addScaledVector(mag.radial, shell);
      mag.axis.set(0.12 + Math.sin(a * 0.7), 1, 0.18 + Math.cos(a * 0.9)).normalize();
      mag.tangent.crossVectors(mag.radial, mag.axis);
      if (mag.tangent.lengthSq() < 0.001) mag.tangent.set(1, 0, 0);
      mag.tangent.normalize();
      particle.v
        .copy(mag.radial)
        .multiplyScalar(0.32 + this._magRandom() * 1.4)
        .addScaledVector(mag.tangent, (this._magRandom() - 0.32) * 1.45);
      for (let s = 0; s < MAG_TRAIL; s++) {
        const o = s * 3;
        particle.trail[o] = particle.p.x;
        particle.trail[o + 1] = particle.p.y;
        particle.trail[o + 2] = particle.p.z;
      }
      particle.ribbonSide.fill(0);
    }

    _updateMagParticles(dt, sampleTrail) {
      const mag = this.mag;
      if (!mag || !this.magLinePos || !this.magHeadPos) return;
      const t = this.elapsed;
      const palette = mag.palette;
      const schemes = [
        [[1.0, 0.12, 0.56], [0.5, 1.0, 0.26], [1.0, 0.91, 0.72]],
        [[0.34, 0.92, 1.0], [0.2, 1.0, 0.62], [0.92, 0.97, 1.0]],
        [[0.72, 0.34, 1.0], [0.94, 0.54, 1.0], [0.88, 0.94, 1.0]],
        [[1.0, 0.1, 0.62], [0.55, 0.16, 1.0], [1.0, 0.82, 0.94]],
      ];
      const scheme = schemes[Math.max(0, mag.preset)] || schemes[0];
      for (let i = 0; i < 3; i++) {
        mag.paletteTarget[i].setRGB(scheme[i][0], scheme[i][1], scheme[i][2]);
        if (palette[i].r + palette[i].g + palette[i].b < 0.0001) {
          palette[i].copy(mag.paletteTarget[i]);
        }
        else palette[i].lerp(mag.paletteTarget[i], 1 - Math.exp(-dt * 0.85));
      }
      this.uniforms.color.value.copy(palette[0]);
      this.uniforms.color2.value.copy(palette[1]);
      this.uniforms.color3.value.copy(palette[2]);
      const lp = this.magLinePos.array;
      const lc = this.magLineCol.array;
      const la = this.magLineAlpha.array;
      const hp = this.magHeadPos.array;
      const hc = this.magHeadCol.array;
      const hs = this.magHeadSize.array;
      const hl = this.magHeadLife.array;
      const rp = this.magRibbonPos.array;
      const rc = this.magRibbonCol.array;
      const ra = this.magRibbonAlpha.array;
      const sp = this.magSpikePos.array;
      const sc = this.magSpikeCol.array;
      const sa = this.magSpikeAlpha.array;
      const center = mag.center;
      const updateGeometry = sampleTrail || !mag.geometryReady;
      let lineVertex = 0;

      mag.flowCount.fill(0);
      for (const flow of mag.flowVelocity) flow.set(0, 0, 0);
      for (const particle of mag.particles) {
        const home = Math.max(0, Math.min(MAG_ATTRACTORS - 1, particle.home | 0));
        mag.flowVelocity[home].add(particle.v);
        mag.flowCount[home]++;
      }
      for (let i = 0; i < MAG_ATTRACTORS; i++) {
        if (mag.flowCount[i]) mag.flowVelocity[i].multiplyScalar(1 / mag.flowCount[i]);
      }

      for (let i = 0; i < mag.particles.length; i++) {
        const p = mag.particles[i];
        p.age += dt;
        p.impactCooldown = Math.max(0, p.impactCooldown - dt);
        const live = this._bandMag(p.band);
        const densityLife = clamp((mag.density - p.seed) * 14 + 0.5, 0, 1);
        const chargeSign = p.chargeTarget < 0 ? -1 : 1;
        p.chargeTarget = chargeSign * (0.24 + live * 0.92);
        p.charge += (p.chargeTarget - p.charge) * (1 - Math.exp(-dt * 3.2));
        let ax = Math.sin(p.p.y * 0.83 + t * 0.23 + p.seed * 8.0) * 0.13;
        let ay = Math.sin(p.p.z * 0.71 - t * 0.19 + p.seed * 5.1) * 0.13;
        let az = Math.sin(p.p.x * 0.77 + t * 0.17 + p.seed * 11.0) * 0.13;
        let nearest = null;
        let nearestD2 = Infinity;

        for (let j = 0; j < mag.orbs.length; j++) {
          const orb = mag.orbs[j];
          const dx = orb.p.x - p.p.x;
          const dy = orb.p.y - p.p.y;
          const dz = orb.p.z - p.p.z;
          const d2 = dx * dx + dy * dy + dz * dz + 0.24;
          const inv = 1 / Math.sqrt(d2);
          if (d2 < nearestD2) {
            nearestD2 = d2;
            nearest = orb;
          }
          const polarity = -p.charge * orb.chargeStrength;
          const homePull = j === p.home ? 0.38 : 0;
          const force = (polarity * (0.38 + live * 0.68) + homePull) / d2;
          ax += dx * inv * force;
          ay += dy * inv * force;
          az += dz * inv * force;
          const swirl = (j === p.home ? 0.16 : 0.055) * (0.45 + live) / (1 + d2 * 0.18);
          ax += (orb.axis.y * dz - orb.axis.z * dy) * inv * swirl;
          ay += (orb.axis.z * dx - orb.axis.x * dz) * inv * swirl;
          az += (orb.axis.x * dy - orb.axis.y * dx) * inv * swirl;
        }

        const flow = mag.flowVelocity[p.home] || mag.flowVelocity[0];
        ax += (flow.x - p.v.x) * 0.042;
        ay += (flow.y - p.v.y) * 0.042;
        az += (flow.z - p.v.z) * 0.042;

        const cx = p.p.x - center.x;
        const cy = p.p.y - center.y;
        const cz = p.p.z - center.z;
        ax += (-cz * 0.024 - cx * 0.016) * (0.55 + live);
        ay += -cy * 0.014;
        az += (cx * 0.024 - cz * 0.016) * (0.55 + live);
        if (mag.pulse > 0.015) {
          const inv = 1 / Math.max(0.5, Math.sqrt(cx * cx + cy * cy + cz * cz));
          ax += cx * inv * mag.pulse * (0.55 + live);
          ay += cy * inv * mag.pulse * (0.55 + live);
          az += cz * inv * mag.pulse * (0.55 + live);
        }

        const accel = Math.sqrt(ax * ax + ay * ay + az * az);
        if (accel > 4.8) {
          const k = 4.8 / accel;
          ax *= k;
          ay *= k;
          az *= k;
        }
        p.v.x += ax * dt;
        p.v.y += ay * dt;
        p.v.z += az * dt;
        const drag = Math.exp(-dt * (0.055 + (1 - live) * 0.025));
        p.v.multiplyScalar(drag);
        const speed = p.v.length();
        const maxSpeed = 2.8 + live * 4.8 + mag.pulse * 2.5;
        if (speed > maxSpeed) p.v.multiplyScalar(maxSpeed / speed);
        p.p.addScaledVector(p.v, dt * (0.9 + live * 0.3));

        if (nearest && p.impactCooldown <= 0) {
          const radius = 0.64 * nearest.scale * this.magCoreScale + 0.09;
          const rawD2 = Math.max(0, nearestD2 - 0.24);
          if (rawD2 < radius * radius) {
            mag.radial.subVectors(p.p, nearest.p);
            if (mag.radial.lengthSq() < 0.0001) mag.radial.set(1, 0, 0);
            mag.radial.normalize();
            const inward = p.v.dot(mag.radial);
            if (inward < 0) p.v.addScaledVector(mag.radial, -1.75 * inward);
            p.v.addScaledVector(mag.radial, 0.35 + live * 0.75);
            const preX = p.p.x;
            const preY = p.p.y;
            const preZ = p.p.z;
            p.p.copy(nearest.p).addScaledVector(mag.radial, radius + 0.025);
            // Pushing the particle out of the orb is a positional correction,
            // not travel. The stored trail has to move with it, or the next
            // sample joins the pre-impact position to the corrected one and
            // draws a segment along the orb radial -- roughly perpendicular to
            // the direction of travel, which reads as a spike off the trail.
            const shiftX = p.p.x - preX;
            const shiftY = p.p.y - preY;
            const shiftZ = p.p.z - preZ;
            const hist = p.trail;
            for (let s = 0; s < MAG_TRAIL; s++) {
              const o = s * 3;
              hist[o] += shiftX;
              hist[o + 1] += shiftY;
              hist[o + 2] += shiftZ;
            }
            p.home = (p.home + 1 + ((p.seed * 17) | 0)) % mag.orbs.length;
            p.impactCooldown = 0.42;
            if (densityLife > 0.15) this._triggerMagImpact(p, live);
          }
        }

        const dx = p.p.x - center.x;
        const dy = p.p.y - center.y;
        const dz = p.p.z - center.z;
        if (p.age > p.life || dx * dx + dy * dy + dz * dz > 150 || !Number.isFinite(p.p.x)) {
          this._resetMagParticle(p);
        }

        const tr = p.trail;
        if (sampleTrail) {
          for (let s = MAG_TRAIL - 1; s > 0; s--) {
            const o = s * 3;
            const prev = o - 3;
            tr[o] = tr[prev];
            tr[o + 1] = tr[prev + 1];
            tr[o + 2] = tr[prev + 2];
          }
        }
        tr[0] = p.p.x;
        tr[1] = p.p.y;
        tr[2] = p.p.z;

        const fadeIn = Math.min(1, p.age * 2.2);
        const fadeOut = Math.min(1, (p.life - p.age) * 0.9);
        const life = Math.max(0, Math.min(fadeIn, fadeOut));
        const visibleLife = life * densityLife;
        const palettePos = clamp(p.band * 1.65 + (p.charge > 0 ? 0.2 : 0), 0, 1.99);
        const ci = Math.min(1, Math.floor(palettePos));
        const cf = palettePos - ci;
        const c0 = palette[ci];
        const c1 = palette[ci + 1];
        const cr = c0.r + (c1.r - c0.r) * cf;
        const cg = c0.g + (c1.g - c0.g) * cf;
        const cb = c0.b + (c1.b - c0.b) * cf;
        const hot = 0.18 + live * 0.82;
        const white = live * live * 0.38 + (p.size > 3.5 ? 0.18 : 0);
        const rr = cr * (1 - white) + white;
        const gg = cg * (1 - white) + white;
        const bb = cb * (1 - white) + white;
        const ho = i * 3;
        hp[ho] = p.p.x;
        hp[ho + 1] = p.p.y;
        hp[ho + 2] = p.p.z;
        hc[ho] = rr;
        hc[ho + 1] = gg;
        hc[ho + 2] = bb;
        hs[i] = p.size * (0.8 + live * 2.8 + mag.pulse * 0.7);
        hl[i] = visibleLife * (0.45 + hot * 0.55);

        if (updateGeometry && i < MAG_SPIKES) {
          const spikeBase = i * 2;
          const origin = mag.orbs[p.home]?.p || center;
          const vx = p.p.x - origin.x;
          const vy = p.p.y - origin.y;
          const vz = p.p.z - origin.z;
          const extend = mag.preset === 2 ? 0.82 + live * 1.45 : 0.16 + live * 0.42;
          for (let end = 0; end < 2; end++) {
            const vertex = spikeBase + end;
            const vo = vertex * 3;
            if (end === 0) {
              sp[vo] = p.p.x;
              sp[vo + 1] = p.p.y;
              sp[vo + 2] = p.p.z;
            } else {
              sp[vo] = p.p.x + vx * extend;
              sp[vo + 1] = p.p.y + vy * extend;
              sp[vo + 2] = p.p.z + vz * extend;
            }
            sc[vo] = rr;
            sc[vo + 1] = gg;
            sc[vo + 2] = bb;
            sa[vertex] = visibleLife * (end ? 0.035 + live * 0.24 : 0.08 + live * 0.36);
          }
        }

        if (updateGeometry) for (let s = 0; s < MAG_TRAIL - 1; s++) {
          const trailFade = 1 - s / (MAG_TRAIL - 1);
          const alpha = visibleLife * trailFade * trailFade * (0.08 + hot * 0.42);
          for (let end = 0; end < 2; end++) {
            const so = (s + end) * 3;
            const vo = lineVertex * 3;
            lp[vo] = tr[so];
            lp[vo + 1] = tr[so + 1];
            lp[vo + 2] = tr[so + 2];
            lc[vo] = rr;
            lc[vo + 1] = gg;
            lc[vo + 2] = bb;
            la[lineVertex] = alpha * (end ? 0.88 : 1);
            lineVertex++;
          }
        }

        if (updateGeometry && i < MAG_RIBBONS) {
          const ribbonBase = i * MAG_TRAIL * 2;
          for (let s = 0; s < MAG_TRAIL; s++) {
            const point = s * 3;
            const prev = Math.max(0, s - 1) * 3;
            const next = Math.min(MAG_TRAIL - 1, s + 1) * 3;
            mag.trailTangent.set(
              tr[next] - tr[prev],
              tr[next + 1] - tr[prev + 1],
              tr[next + 2] - tr[prev + 2]
            );
            mag.trailView.set(
              this.camera.position.x - tr[point],
              this.camera.position.y - tr[point + 1],
              this.camera.position.z - tr[point + 2]
            );
            mag.trailSide.crossVectors(mag.trailTangent, mag.trailView);
            if (mag.trailSide.lengthSq() < 0.000001) mag.trailSide.set(1, 0, 0);
            mag.trailSide.normalize();
            const sideOffset = s * 3;
            const oldX = p.ribbonSide[sideOffset];
            const oldY = p.ribbonSide[sideOffset + 1];
            const oldZ = p.ribbonSide[sideOffset + 2];
            const oldLen2 = oldX * oldX + oldY * oldY + oldZ * oldZ;
            if (oldLen2 > 0.0001) {
              if (oldX * mag.trailSide.x + oldY * mag.trailSide.y + oldZ * mag.trailSide.z < 0) {
                mag.trailSide.multiplyScalar(-1);
              }
              mag.trailSide.set(
                oldX * 0.72 + mag.trailSide.x * 0.28,
                oldY * 0.72 + mag.trailSide.y * 0.28,
                oldZ * 0.72 + mag.trailSide.z * 0.28
              ).normalize();
            }
            p.ribbonSide[sideOffset] = mag.trailSide.x;
            p.ribbonSide[sideOffset + 1] = mag.trailSide.y;
            p.ribbonSide[sideOffset + 2] = mag.trailSide.z;
            const trailFade = 1 - s / (MAG_TRAIL - 1);
            const u = s / (MAG_TRAIL - 1);
            let profile = Math.pow(Math.max(0, Math.sin(u * Math.PI)), 0.62);
            if (mag.preset === 2) profile = 0.18 + profile * 0.82;
            if (mag.preset === 3) {
              profile *= 0.58 + 0.42 * Math.abs(Math.sin(u * 8.0 + p.seed * 13.0));
            }
            const ribbonScale = mag.preset === 3 ? 6.8 : mag.preset === 1 ? 2.1 : 1.25;
            const width =
              (0.008 + p.size * 0.006 + live * 0.018) *
              profile * visibleLife * ribbonScale * this.params.magRibbon;
            const alpha = visibleLife * Math.pow(trailFade, 0.8) * profile * (0.024 + hot * 0.12);
            for (let side = 0; side < 2; side++) {
              const sign = side ? -1 : 1;
              const vertex = ribbonBase + s * 2 + side;
              const vo = vertex * 3;
              rp[vo] = tr[point] + mag.trailSide.x * width * sign;
              rp[vo + 1] = tr[point + 1] + mag.trailSide.y * width * sign;
              rp[vo + 2] = tr[point + 2] + mag.trailSide.z * width * sign;
              const shade = side ? 0.68 : 1.05;
              rc[vo] = rr * shade;
              rc[vo + 1] = gg * shade;
              rc[vo + 2] = bb * shade;
              ra[vertex] = alpha;
            }
          }
        }
      }

      this._updateMagFlares(dt);
      if (updateGeometry) {
        this.magLinePos.needsUpdate = true;
        this.magLineCol.needsUpdate = true;
        this.magLineAlpha.needsUpdate = true;
        this.magRibbonPos.needsUpdate = true;
        this.magRibbonCol.needsUpdate = true;
        this.magRibbonAlpha.needsUpdate = true;
        this.magSpikePos.needsUpdate = true;
        this.magSpikeCol.needsUpdate = true;
        this.magSpikeAlpha.needsUpdate = true;
        mag.geometryReady = true;
        mag.geometryBuilds++;
      }
      this.magHeadPos.needsUpdate = true;
      this.magHeadCol.needsUpdate = true;
      this.magHeadSize.needsUpdate = true;
      this.magHeadLife.needsUpdate = true;
    }

    _triggerMagImpact(particle, live) {
      let flare = null;
      for (const event of this.mag.flareEvents) {
        if (event.life <= 0.01) {
          flare = event;
          break;
        }
      }
      if (!flare && this.mag.flareEvents.length < 12) {
        flare = { p: new THREE.Vector3(), life: 0, size: 0, colorIndex: 0 };
        this.mag.flareEvents.push(flare);
      }
      if (!flare) {
        flare = this.mag.flareEvents.reduce((a, b) => (a.life < b.life ? a : b));
      }
      flare.p.copy(particle.p);
      flare.life = 0.5 + live * 0.5;
      flare.size = 7 + live * 19 + this.kick * 10;
      flare.colorIndex = Math.min(2, (particle.band * 3) | 0);
    }

    _updateMagFlares(dt) {
      const mag = this.mag;
      if (!mag || !this.magFlarePos) return;
      const fp = this.magFlarePos.array;
      const fc = this.magFlareCol.array;
      const fs = this.magFlareSize.array;
      const fl = this.magFlareLife.array;
      const t = this.elapsed;
      for (const event of mag.flareEvents) event.life *= Math.exp(-dt * 5.2);
      for (let i = 0; i < fl.length; i++) {
        const o = i * 3;
        if (i < 2) {
          fp[o] = mag.center.x - 0.72 + Math.sin(t * 0.21) * 0.28;
          fp[o + 1] = mag.center.y - 0.62 + Math.cos(t * 0.17) * 0.24;
          fp[o + 2] = mag.center.z + Math.sin(t * 0.13) * 0.3;
          fs[i] = i === 0
            ? 18 + this.smoothBass * 36 + mag.pulse * 24
            : 54 + this.smoothBass * 74 + mag.pulse * 48;
          fl[i] = i === 0 ? 0.62 + this.energy * 0.36 : 0.08 + this.energy * 0.11;
        } else if (mag.flareEvents[i - 2]?.life > 0.01) {
          const event = mag.flareEvents[i - 2];
          fp[o] = event.p.x;
          fp[o + 1] = event.p.y;
          fp[o + 2] = event.p.z;
          fs[i] = event.size * (0.7 + event.life * 0.8);
          fl[i] = event.life;
        } else {
          const p = mag.particles[(i * 137 + 19) % mag.particles.length];
          const live = this._bandMag(p.band);
          const densityLife = clamp((mag.density - p.seed) * 14 + 0.5, 0, 1);
          fp[o] = p.p.x;
          fp[o + 1] = p.p.y;
          fp[o + 2] = p.p.z;
          fs[i] = (4 + p.size * 1.8) * (0.55 + live * 1.4);
          fl[i] =
            (0.12 + live * live * 0.72) * Math.min(1, p.age * 2) * densityLife;
        }
        const eventColor = i >= 2 ? mag.flareEvents[i - 2]?.colorIndex : null;
        const colorIndex = eventColor == null ? i % 3 : eventColor;
        const tint = mag.palette[colorIndex];
        const white = i < 2 ? 0.84 : 0.42;
        fc[o] = tint.r * (1 - white) + white;
        fc[o + 1] = tint.g * (1 - white) + white;
        fc[o + 2] = tint.b * (1 - white) + white;
      }
      this.magFlarePos.needsUpdate = true;
      this.magFlareCol.needsUpdate = true;
      this.magFlareSize.needsUpdate = true;
      this.magFlareLife.needsUpdate = true;
    }

    _tickBloom(dt) {
      const p = this.params;
      const t = this.elapsed;
      const s = clamp(p.sensitivity ?? 1, 0, 2.2);
      const react = Math.min(1.12, s);
      const drift = (speed, amt, phase) => Math.sin(t * speed + phase) * amt;
      const u = this.uniforms;
      // Accent rather than kick: under the grid it swells INTO the beat, so
      // the nebula is already opening when the kick lands instead of starting
      // to open once it has.
      const m = this.motion;
      const danceTarget = clamp(
        (this.rawSmoothBass * 0.34 + m.accent * 0.74 + m.kick * 0.10 + this.energy * 0.16) * react,
        0,
        1.2
      );
      if (!Number.isFinite(this.bloomDance)) this.bloomDance = 0;
      const danceRate = danceTarget > this.bloomDance ? 24 : 7.5;
      this.bloomDance +=
        (danceTarget - this.bloomDance) * (1 - Math.exp(-Math.max(0, dt) * danceRate));
      if (u) {
        if (u.bloomReact) u.bloomReact.value = react;
        if (u.bloomDance) u.bloomDance.value = this.bloomDance;
        if (u.bloomShape) {
          // The old drift was +-0.105 but on 150 s and 370 s periods, which is
          // far too slow to read as movement at all. The fix is mostly rate,
          // not amount: the leading term now cycles in ~70 s. bloomShape
          // flattens the nebula into a disc, so a little goes a long way.
          u.bloomShape.value = clamp(
            p.bloomShape +
              drift(0.09, 0.085, 0.3) +
              drift(0.032, 0.05, 1.7) +
              (m.phrase - 0.5) * 0.05 * m.gridMix,
            0,
            1
          );
        }
        if (u.bloomHue) u.bloomHue.value = clamp(p.bloomHue + drift(0.027, 0.05, 0.8), 0, 1);
        if (u.bloomWarm) u.bloomWarm.value = clamp(p.bloomWarm + drift(0.033, 0.045, 2.1), 0, 1);
        if (u.bloomSoft) u.bloomSoft.value = clamp(p.bloomSoft + drift(0.021, 0.04, 0.4), 0, 1);
        if (u.bloomSpark) u.bloomSpark.value = clamp(p.bloomSpark + drift(0.049, 0.045, 1.2), 0, 1);
        if (u.bloomSize) u.bloomSize.value = p.bloomSize * (1 + drift(0.019, 0.04, 0.6));
        if (u.bloomSpread) u.bloomSpread.value = clamp(p.bloomSpread * (1 + drift(0.023, 0.05, 2.4)), 0, 1.6);
        if (u.bloomBright) u.bloomBright.value = clamp(
          p.bloomBright * (1 + drift(0.015, 0.025, 1.1)),
          0.58,
          0.85
        );
        if (u.bloomTight) u.bloomTight.value = clamp(p.bloomTight + drift(0.014, 0.035, 0.9), 0, 1);
      }
      const spinFlow = clamp(
        0.84 + drift(0.041, 0.2, 0.5) + drift(0.013, 0.09, 2.1) + drift(0.083, 0.055, 1.4),
        0.48,
        1.18
      );
      this.bloomReact = react;
      // Inner spin is exactly the original expression -- same base rate, same
      // flow, same accumulation, and no beat impulse on the angle. The beat
      // nudge made the whole disc lurch once a bar, which combined with the
      // fly-through camera read as the camera itself misbehaving.
      const baseRate = (0.09 + this.rawSmoothBass * 0.18 * react) * spinFlow;
      const innerSpin = p.bloomSpin ?? 1;
      const outerSpin = p.bloomSwirl ?? 1.5;
      this.bloom.rotation.y += dt * baseRate * innerSpin;
      // Outer spin is the SAME scale as inner: at equal values the cloud turns
      // rigidly, 0 leaves the rings standing still, and anything above the
      // inner value makes them lead. The object rotation already carries the
      // inner speed, so only the difference is sheared in.
      this._bloomSwirl = (this._bloomSwirl || 0) + dt * baseRate * (outerSpin - innerSpin);
      if (u && u.bloomSwirlAngle) u.bloomSwirlAngle.value = this._bloomSwirl;
      this.bloom.rotation.x =
        0.08 + Math.sin(t * 0.071 + 0.6) * 0.24 + Math.sin(t * 0.023) * 0.08;
      this.bloom.rotation.z =
        Math.sin(t * 0.053) * 0.2 + Math.sin(t * 0.019 + 1.8) * 0.07;
      this.bloom.position.set(
        Math.sin(t * 0.027) * 0.28,
        Math.sin(t * 0.037 + 1.1) * 0.34,
        Math.sin(t * 0.021 + 2.3) * 0.2
      );
      this.bloom.scale.setScalar(1 + this.bloomDance * 0.035);
    }

    _updateBands(dt = 1 / 60) {
      const bins = 32;
      const data = this.bandData;
      if (!data) return;
      const step = dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
      for (let i = 0; i < bins; i++) {
        const mag = this._bandMag(i / (bins - 1));
        const o = i * 4;
        const target = Math.min(1, mag);
        const current = data[o] / 255;
        const rate = target > current ? 28 : 9;
        const smooth = this.mode === "bloom" || this.mode === "pulse"
          ? current + (target - current) * (1 - Math.exp(-step * rate))
          : target;
        const v = Math.min(255, smooth * 255);
        data[o] = v;
        data[o + 1] = v;
        data[o + 2] = v;
        data[o + 3] = 255;
      }
      this.bandTex.needsUpdate = true;
    }

    _updateCamera(dt) {
      if (this.mode === "magnetosphere" && this.magOptions.cameraLock) {
        this.mag.cameraLocked = true;
        return;
      }
      if (this.mag) this.mag.cameraLocked = false;
      const zoom = clamp(this.params.ridgeZoom || 2.4, 2.2, 3.5);
      const height = clamp(this.params.ridgeHeight || 1.15, 0.7, 4.5);
      const u = (zoom - 2.2) / 1.3;
      let magnetosphereCam = [0, 0.85, 4.8];
      if (this.mode === "magnetosphere" && this.mag) {
        // Level into angular velocity again: a busy passage used to spin the
        // camera faster and faster. Base rate plus a phrase-scale term, so the
        // camera moves with the form rather than with the loudness.
        this.mag.yaw += dt * (0.026 + 0.010 * this.motion.calm + this.motion.phrase * 0.012);
        const travel = 0.5 + 0.5 * Math.sin(this.elapsed * 0.019 - 0.8);
        const presetPull = [0, 1.65, 0.35, 1.05][Math.max(0, this.mag.preset)] || 0;
        const rad = Math.max(3.35, 7.35 - travel * 2.15 - presetPull - this.kick * 0.18);
        magnetosphereCam = [
          Math.sin(this.mag.yaw) * (1.15 + travel * 0.7),
          0.72 + Math.sin(this.elapsed * 0.037) * 1.15,
          Math.cos(this.mag.yaw * 0.32) * 0.42 + rad,
        ];
      }
      const bloomReact = this.bloomReact ?? Math.min(1.12, this.params.sensitivity ?? 1);
      const bloomFlight = this.elapsed * 0.078 + 0.25;
      const bloomSide = Math.tanh(Math.cos(bloomFlight) * 5) / Math.tanh(5);
      const bloomThrough = Math.pow(1 - Math.min(1, Math.abs(bloomSide)), 0.72);
      const targetFov = this.mode === "magnetosphere"
        ? [58, 52, 62, 66][Math.max(0, this.mag?.preset || 0)]
        : this.mode === "bloom" ? 63 + bloomThrough * 10
        : this.mode === "dance" ? 52 : 60;
      const nextFov = this.camera.fov + (targetFov - this.camera.fov) * Math.min(1, dt * 0.7);
      if (Math.abs(nextFov - this.camera.fov) > 0.001) {
        this.camera.fov = nextFov;
        this.camera.updateProjectionMatrix();
      }
      const bloomRadius = 2.65 + Math.cos(bloomFlight * 2) * 0.45;
      const bloomCam = [
        Math.sin(bloomFlight) * bloomRadius + Math.sin(bloomFlight * 3) * 0.3,
        0.55 + Math.sin(bloomFlight * 1.7 + 0.4) * 1.55 + Math.sin(bloomFlight * 4) * 0.24,
        bloomSide * 9.6 + Math.cos(bloomFlight * 2) * 0.4 - (this.bloomDance || 0) * 0.08,
      ];
      // Slow orbit so the figures are seen from changing angles; the phrase
      // term makes the move belong to the music's form rather than a timer.
      this._danceYaw = (this._danceYaw || 0) + dt * (0.05 + this.motion.phrase * 0.03 * this.motion.gridMix);
      const danceCam = [
        Math.sin(this._danceYaw) * 1.2,
        0.35 + Math.sin(this.elapsed * 0.05) * 0.22,
        4.35 + Math.cos(this._danceYaw) * 0.45,
      ];
      const bases = {
        pulse: [0, 0.35, 7.2],
        dance: danceCam,
        ridge: [0, 7.1 + height * 0.75 - u * 0.2, 11.2 - u * 1.4],
        bloom: bloomCam,
        magnetosphere: magnetosphereCam,
      };
      const base = bases[this.mode] || bases.pulse;
      if (!this._camBase) this._camBase = { x: base[0], y: base[1], z: base[2] };
      const k = Math.min(1, dt * (this.mode === "magnetosphere" ? 1.05 : 2.2));
      this._camBase.x += (base[0] - this._camBase.x) * k;
      this._camBase.y += (base[1] - this._camBase.y) * k;
      this._camBase.z += (base[2] - this._camBase.z) * k;

      let figX = 0;
      let figY = 0;
      let figZ = 0;
      this._cameraLook ||= new THREE.Vector3();
      const look = this._cameraLook.set(0, 0, 0);
      const t = this.elapsed;
      if (this.mode === "ridge") {
        const w = 0.26;
        figX = Math.sin(w * t) * 3.05;
        figY = Math.sin(2 * w * t) * 1.35;
        figZ = Math.sin(w * t) * Math.cos(w * t) * 1.85;
        const lookY = 0.28 + height * 0.22;
        const lookZ = -8.4 + u * 0.8;
        this.camera.position.set(this._camBase.x, this._camBase.y, this._camBase.z);
        this.camera.lookAt(0, lookY, lookZ);
        this._fitRidgeToView(u);
        look.set(figX * 0.12, lookY + figY * 0.08, lookZ);
      } else if (this.mode === "bloom") {
        look.copy(this.bloom.position);
        look.x += Math.cos(bloomFlight) * 0.42 + Math.sin(t * 0.041) * 0.16;
        look.y += Math.sin(bloomFlight * 2) * 0.3;
        look.z -= Math.sin(bloomFlight) * 0.46;
      } else if (this.mode === "magnetosphere") {
        if (this.magnetosphereMid) look.copy(this.magnetosphereMid);
      }
      this.camera.position.set(
        this._camBase.x + figX,
        this._camBase.y + figY,
        this._camBase.z + figZ
      );
      this.camera.lookAt(look);
      if (this.mode === "bloom") {
        this.camera.rotateZ(
          Math.sin(bloomFlight) * 0.075 + Math.sin(bloomFlight * 3 + 0.5) * 0.025
        );
      }
    }

    _fitRidgeToView(zoomU) {
      if (!this.ridge || !this.camera) return;
      if (!this._fitPt) {
        this._fitPt = new THREE.Vector3();
        this._fitNdc = new THREE.Vector3();
      }
      this.ridge.scale.x = 1;
      this.ridge.updateMatrixWorld(true);
      this.camera.updateMatrixWorld();
      this._fitPt.set(9, 0, 0);
      this.ridge.localToWorld(this._fitPt);
      this._fitNdc.copy(this._fitPt).project(this.camera);
      const nx = Math.abs(this._fitNdc.x);
      if (!Number.isFinite(nx) || nx < 0.02) {
        this.ridge.scale.x = 4;
        return;
      }
      const target = 0.92 + zoomU * 0.42;
      const next = clamp(target / nx, 1, 16);
      this._ridgeFitX = this._ridgeFitX == null ? next : this._ridgeFitX + (next - this._ridgeFitX) * 0.35;
      this.ridge.scale.x = this._ridgeFitX;
      if (this.ridgeMotes) {
        this.ridgeMotes.scale.x = 1 / Math.max(this.ridge.scale.x, 0.001);
      }
    }

    _shape(v) {
      const s = clamp(this.params.sensitivity ?? 1, 0, 2.2);
      if (s <= 0.001) return 0;
      const agc = this.dynGain || 1;
      const floor = Math.max(0, 0.035 / Math.max(0.4, s));
      const gain = Math.min(2.6, agc * (0.62 + s * 0.52));
      const x = clamp((v - floor) * gain, 0, 1);
      return Math.pow(x, 0.78 + 0.22 / Math.max(0.4, s));
    }

    _mag(t) {
      return this._shape(lerpFreq(this.freq, t) / 255);
    }

    _bandMag(t) {
      const v = lerpFreq(this.freq, t) / 255;
      const agc = this.dynGain || 1;
      const x = clamp((v - 0.035) * Math.min(2.15, agc * 1.08), 0, 1);
      return Math.pow(x, 0.86);
    }

    _updateLiveColor() {
      let [r0, g0, b0] = this.accent;
      const chroma = Math.max(r0, g0, b0) - Math.min(r0, g0, b0);
      if (chroma < 22) {
        r0 = 255;
        g0 = 96;
        b0 = 40;
      }
      const drift =
        Math.sin(this.elapsed * 0.07) * 0.045 + Math.sin(this.elapsed * 0.023) * 0.025;
      const sat = 1 + 0.06 * Math.sin(this.elapsed * 0.05);
      const rgb = shiftHue(r0, g0, b0, drift, sat);
      const rgb2 = shiftHue(r0, g0, b0, drift + 0.42, sat);
      const rgb3 = shiftHue(r0, g0, b0, drift + 0.13, sat);
      this.liveAccent = rgb;
      this.liveAccent2 = rgb2;
      if (this.uniforms) {
        this.uniforms.color.value.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255);
        this.uniforms.color2.value.setRGB(rgb2[0] / 255, rgb2[1] / 255, rgb2[2] / 255);
        this.uniforms.color3?.value.setRGB(rgb3[0] / 255, rgb3[1] / 255, rgb3[2] / 255);
      }
    }

    _analyse(dt) {
      if (this.engineDriven) return;
      const freq = this.freq;
      if (!freq.length) return;
      const Audio = globalThis.ScvizAudio;
      if (!Audio) {
        if (!this._warnedNoEngine) {
          this._warnedNoEngine = true;
          console.warn("Soundstage: audio-engine.js not loaded; audio features are inert");
        }
        return;
      }
      const n = freq.length;
      if (!this._features || this._featureBuckets !== n) {
        this._featureBuckets = n;
        this._featureBands = new Float32Array(n);
        this._features = new Audio.Features({
          buckets: n,
          bassEnd: Math.round(n * 0.18),
          midEnd: Math.round(n * 0.55),
        });
      }
      const bands = this._featureBands;
      for (let i = 0; i < n; i++) bands[i] = freq[i] / 255;
      const f = this._features.update(bands, dt);
      this.bass = f.bass;
      this.mid = f.mid;
      this.high = f.high;
      this.smoothBass = f.smoothBass;
      this.rawSmoothBass = f.rawSmoothBass;
      this.kick = f.kick;
      this.loudness = f.loudness;
      this.energy = f.energy;
      this.integratedPower = f.integratedPower;
      this.flux = f.flux;
      this.dynGain = f.dynGain;
      this.dynPeak = f.dynPeak;
    }

    _drawWaveform() {
      const ctx = this.waveCtx;
      const { width: w, height: h } = this.waveCanvas;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      const padY = Math.round(h * 0.08);
      const mid = h * 0.52;
      const amp = (h - padY * 2) * 0.46;
      const [r, g, b] = this.liveAccent;
      const samples = this.samples;
      const progressX = w * this.progress;
      if (samples.length) {
        const count = Math.min(samples.length, Math.floor(w / 2.6));
        const step = samples.length / count;
        const barW = Math.max(1.1, w / count - 0.9);
        let max = 1;
        for (const s of samples) if (s > max) max = s;
        for (let i = 0; i < count; i++) {
          const idx = Math.min(samples.length - 1, (i * step) | 0);
          const mag = samples[idx] / max;
          const x = (i / count) * w;
          const bh = Math.max(2, mag * amp);
          const played = x <= progressX;
          ctx.fillStyle = played ? `rgba(${r},${g},${b},0.88)` : "rgba(255,255,255,0.2)";
          ctx.fillRect(x, mid - bh, barW, bh);
          ctx.fillStyle = played ? `rgba(${r},${g},${b},0.32)` : "rgba(255,255,255,0.08)";
          ctx.fillRect(x, mid, barW, bh * 0.9);
        }
      }
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      this._strokeScope(ctx, this.time, 0, w, mid, h * 0.34, r, g, b, 1);
      ctx.restore();
      ctx.fillStyle = `rgba(${r},${g},${b},0.95)`;
      ctx.fillRect(progressX, padY * 0.4, 2, h - padY * 0.8);
    }

    _strokeScope(ctx, time, x0, x1, mid, amp, r, g, b, sign) {
      if (!time.length) return;
      const n = time.length;
      const path = () => {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const x = x0 + ((x1 - x0) * i) / (n - 1);
          const y = mid + sign * Math.tanh(((time[i] - 128) / 128) * 2.2) * amp;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
      };
      path();
      ctx.strokeStyle = `rgba(${r},${g},${b},0.16)`;
      ctx.lineWidth = 18;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.stroke();
      path();
      ctx.strokeStyle = `rgba(${r},${g},${b},0.45)`;
      ctx.lineWidth = 7;
      ctx.stroke();
      path();
      ctx.strokeStyle = `rgba(255,255,255,${0.75 + this.energy * 0.2})`;
      ctx.lineWidth = 2.2;
      ctx.stroke();
    }
  }

  function M_smoothstep(a, b, x) {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-9)));
    return t * t * (3 - 2 * t);
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function shiftHue(r, g, b, dHue, satMul) {
    const inv = 1 / 255;
    let R = r * inv;
    let G = g * inv;
    let B = b * inv;
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === R) h = (G - B) / d + (G < B ? 6 : 0);
      else if (max === G) h = (B - R) / d + 2;
      else h = (R - G) / d + 4;
      h /= 6;
    }
    h = (h + dHue) % 1;
    if (h < 0) h += 1;
    s = Math.min(1, Math.max(0, s * (satMul || 1)));
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (p0, q0, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p0 + (q0 - p0) * 6 * t;
      if (t < 1 / 2) return q0;
      if (t < 2 / 3) return p0 + (q0 - p0) * (2 / 3 - t) * 6;
      return p0;
    };
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  function lerpFreq(freq, t) {
    if (!freq?.length) return 0;
    const x = Math.min(1, Math.max(0, t)) * (freq.length - 1);
    const i = Math.floor(x);
    const f = x - i;
    const a = freq[i] || 0;
    const b = freq[Math.min(freq.length - 1, i + 1)] || 0;
    return a + (b - a) * f;
  }

  function fitCanvas(canvas, ctx) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  globalThis.SCVizVisualizer = SCVizVisualizer;
})();
