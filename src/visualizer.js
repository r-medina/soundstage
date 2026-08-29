"use strict";

(() => {
  const MODES = [
    { id: "pulse", label: "Pulse" },
    { id: "ridge", label: "Ridge" },
    { id: "bloom", label: "Bloom" },
    { id: "magnetosphere", label: "Magnetosphere" },
  ];
  const LEGACY = {
    orb: "pulse",
    bars: "ridge",
    scope: "ridge",
    storm: "bloom",
    tunnel: "pulse",
  };
  const RIDGE_ROWS = 260;
  const RIDGE_COLS = 160;
  const RIDGE_STEP = 0.04;
  const BLOOM_COUNT = 7000;
  const MAG_ATTRACTORS = 5;
  const MAG_PARTICLES = 1600;
  const MAG_TRAIL = 42;
  const MAG_RIBBONS = 72;
  const MAG_SPIKES = 260;
  const MAG_RING_SEGS = 64;
  const MAG_NEBULA = 720;
  const MAG_VOID_LAYER = 30;

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
      this.bass = 0;
      this.mid = 0;
      this.high = 0;
      this.smoothBass = 0;
      this.rawSmoothBass = 0;
      this.kick = 0;
      this.hasAudio = false;
      this.mode = "pulse";
      this.discEl = null;
      this.running = false;
      this.raf = 0;
      this.last = 0;
      this.elapsed = 0;
      this.artUrl = "";
      this.params = {
        bloomBright: 0.72,
        bloomSize: 1,
        bloomSpread: 0.55,
        bloomSpin: 1,
        bloomShape: 0.28,
        bloomHue: 0.72,
        bloomWarm: 0.42,
        bloomSpark: 0.48,
        bloomSoft: 0.55,
        bloomTight: 0,
        ridgeZoom: 2.4,
        ridgeHeight: 1.15,
        ridgeThick: 0.55,
        ridgeFreq: 1,
        ridgeFuzz: 0.28,
        sensitivity: 1,
      };
      this.liveAccent = [255, 85, 0];
      this.liveAccent2 = [40, 140, 255];
      this.dynPeak = 0.32;
      this.dynGain = 1;
      this._camBase = null;
      this.ridgeAcc = 0;
      this.magnetosphereMid = null;
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
      const resolved = LEGACY[id] || id;
      this.mode = MODES.some((m) => m.id === resolved) ? resolved : "pulse";
      if (this.pulse) {
        this.pulse.visible = this.mode === "pulse";
        this.ridge.visible = this.mode === "ridge";
        this.bloom.visible = this.mode === "bloom";
        if (this.magnetosphere) this.magnetosphere.visible = this.mode === "magnetosphere";
      }
      if (this.scene) {
        this.scene.fog = this.mode === "ridge" ? this.ridgeFog : null;
      }
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
        bloomBright: [0.58, 1],
        bloomSize: [0.4, 2.2],
        bloomSpread: [0, 1.6],
        bloomSpin: [0, 2.5],
        bloomShape: [0, 1],
        bloomHue: [0, 1],
        bloomWarm: [0, 1],
        bloomSpark: [0, 1],
        bloomSoft: [0, 1],
        bloomTight: [0, 1],
        ridgeZoom: [2.2, 3.5],
        ridgeHeight: [0.7, 2],
        ridgeThick: [0.15, 2],
        ridgeFreq: [0.2, 1],
        ridgeFuzz: [0, 1],
        sensitivity: [0, 2.2],
      };
      for (const [key, range] of Object.entries(limits)) {
        this.params[key] = clamp(this.params[key], range[0], range[1]);
        if (this.uniforms?.[key]) this.uniforms[key].value = this.params[key];
      }
      if (this.ridgeGeo) this._syncRidgeIndex();
    }

    cycleMode() {
      const i = MODES.findIndex((m) => m.id === this.mode);
      this.setMode(MODES[(i + 1) % MODES.length].id);
      return this.mode;
    }

    setAudio(freq, time) {
      if (freq?.length) {
        this.freq = Uint8Array.from(freq);
        this.hasAudio = true;
      }
      if (time?.length) this.time = Uint8Array.from(time);
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
          });
        })
        .catch(() => {});
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.last = performance.now();
      const loop = (now) => {
        if (!this.running) return;
        try {
          const dt = Math.min(0.05, (now - this.last) / 1000);
          this.last = now;
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
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (this.renderer) {
        this.renderer.setPixelRatio(dpr);
        this.renderer.setSize(Math.max(1, rect.width), Math.max(1, rect.height), false);
        this.camera.aspect = rect.width / Math.max(1, rect.height);
        this.camera.updateProjectionMatrix();
        if (this.magPost) {
          this._postSize ||= new THREE.Vector2();
          this.renderer.getDrawingBufferSize(this._postSize);
          this.magPost.resize(this._postSize.x, this._postSize.y);
        }
      }
      if (this.mode === "ridge") {
        const zoom = clamp(this.params.ridgeZoom || 2.4, 2.2, 3.5);
        this._fitRidgeToView((zoom - 2.2) / 1.3);
      }
      fitCanvas(this.waveCanvas, this.waveCtx);
    }

    _initThree() {
      if (typeof THREE === "undefined") {
        console.error("SCViz: THREE is missing");
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
      this.magPost = typeof SCVizMagnetospherePost !== "undefined"
        ? new SCVizMagnetospherePost(this.renderer)
        : null;
      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 260);
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
        color2: { value: new THREE.Color(0.16, 0.55, 1) },
        color3: { value: new THREE.Color(1, 0.55, 0.18) },
        ridgeThick: { value: this.params.ridgeThick },
        ridgeFreq: { value: this.params.ridgeFreq },
        ridgeFuzz: { value: this.params.ridgeFuzz },
        orbA: { value: new THREE.Vector3(1.6, 0, 0) },
        orbB: { value: new THREE.Vector3(-1.6, 0, 0) },
        couple: { value: 0.5 },
      };
      this.ridgeFog = new THREE.FogExp2(0x08141e, 0.015);
      this.pulse = this._makePulse();
      this.ridge = this._makeRidge();
      this.bloom = this._makeBloom();
      this.magnetosphere = this._makeMagnetosphere();
      this.scene.add(this.pulse, this.ridge, this.bloom, this.magnetosphere);
      this.setMode(this.mode);
      this.resize();
    }

    _makePulse() {
      const group = new THREE.Group();
      const outerMat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        wireframe: true,
        transparent: true,
        depthWrite: false,
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
          varying vec3 vNormal;
          varying vec3 vWorldPos;
          void main() {
            vec3 viewDir = normalize(cameraPosition - vWorldPos);
            float fresnel = 1.0 - max(0.0, dot(viewDir, normalize(vNormal)));
            fresnel = pow(fresnel, 1.6 + audioLevel * 2.2);
            float pulse = 0.75 + 0.25 * sin(time * 2.0);
            vec3 col = color * fresnel * pulse * (1.15 + audioLevel * 1.1);
            col += vec3(1.0) * fresnel * fresnel * 0.35;
            float alpha = fresnel * (0.55 + audioLevel * 0.35);
            gl_FragColor = vec4(col, alpha);
          }
        `,
      });
      const outer = new THREE.Mesh(new THREE.IcosahedronGeometry(1.55, 4), outerMat);
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
          varying vec3 vNormal;
          varying vec3 vWorldPos;
          void main() {
            vec3 viewDir = normalize(cameraPosition - vWorldPos);
            float fresnel = pow(1.0 - max(0.0, dot(viewDir, normalize(vNormal))), 3.0);
            float a = fresnel * (0.22 + audioLevel * 0.45);
            gl_FragColor = vec4(color * (1.2 + audioLevel), a);
          }
        `,
      });
      const glow = new THREE.Mesh(new THREE.SphereGeometry(1.95, 32, 32), glowMat);
      this.artMat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.52,
        depthWrite: false,
      });
      this.artMesh = new THREE.Mesh(new THREE.CircleGeometry(0.82, 48), this.artMat);
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
          varying float vGain;
          varying float vSeed;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            if (max(abs(p.x), abs(p.y)) > 0.48) discard;
            float edge = 1.0 - smoothstep(0.38, 0.48, max(abs(p.x), abs(p.y)));
            float lit = 0.12 + vSeed * 0.08 + vGain * vGain * 1.35;
            gl_FragColor = vec4(color * (0.55 + vGain * 1.6), edge * lit);
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
      this.ridgeLineMat = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 1,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      group.add(new THREE.LineSegments(geo, this.ridgeLineMat));
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
          varying vec2 vUv;
          void main() {
            float h = vUv.y;
            vec3 zenith = vec3(0.008, 0.016, 0.03);
            vec3 belt = mix(vec3(0.03, 0.055, 0.09), color, 0.28 + 0.1 * sin(time * 0.06));
            float horz = pow(smoothstep(0.08, 0.42, h) * (1.0 - smoothstep(0.42, 0.78, h)), 1.1);
            vec3 col = mix(zenith, belt, horz);
            col += color * audioLevel * 0.04 * horz;
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
          varying vec2 vUv;
          void main() {
            float gx = 1.0 - pow(abs(vUv.x - 0.5) * 2.0, 1.6);
            float gy = exp(-pow((vUv.y - 0.5) * 7.5, 2.0));
            float glow = gx * gy;
            vec3 col = mix(color, vec3(0.75, 0.88, 1.0), 0.35);
            gl_FragColor = vec4(col * (0.7 + audioLevel * 0.45), glow * (0.28 + audioLevel * 0.18));
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
            gl_FragColor = vec4(tint * twinkle, glow * vAlpha * twinkle);
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
      for (let i = 0; i < BLOOM_COUNT; i++) {
        const mode = Math.random();
        if (mode < 0.65) {
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
        }
        seeds[i] = Math.random();
        sizes[i] = Math.pow(Math.random(), 2.35) * 3.4 + 0.18;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      geo.setAttribute("seed", new THREE.BufferAttribute(seeds, 1));
      geo.setAttribute("band", new THREE.BufferAttribute(bands, 1));
      geo.setAttribute("psize", new THREE.BufferAttribute(sizes, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        vertexShader: `
          attribute float seed;
          attribute float band;
          attribute float psize;
          uniform float bass;
          uniform sampler2D bands;
          uniform float bloomSize;
          uniform float bloomSpread;
          uniform float bloomShape;
          uniform float bloomTight;
          uniform float bloomReact;
          varying float vAlpha;
          varying float vGain;
          varying float vLive;
          varying float vBand;
          varying float vSeed;
          void main() {
            float g = texture2D(bands, vec2(band * 0.97 + 0.015, 0.5)).r;
            g = pow(g, 0.95);
            float live = g * bloomReact;
            vGain = g;
            vLive = live;
            vBand = band;
            vSeed = seed;
            vec3 pos = position;
            pos *= mix(1.42, 0.4, bloomTight);
            pos.y *= mix(1.0, 0.1, bloomShape);
            pos.xz *= mix(1.0, 1.0 + bloomShape * 0.42, bloomShape);
            float pulse = 1.0 + live * bloomSpread * 0.22;
            vec4 mv = modelViewMatrix * vec4(pos * pulse, 1.0);
            gl_Position = projectionMatrix * mv;
            float dist = -mv.z;
            float size = psize * bloomSize * mix(32.0, 52.0, live);
            gl_PointSize = size / max(dist * 0.42, 0.5);
            vAlpha = 0.42 + seed * 0.16 + live * 0.16;
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
          varying float vAlpha;
          varying float vGain;
          varying float vLive;
          varying float vBand;
          varying float vSeed;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            float d = length(p);
            if (d > 0.5) discard;
            float glow = pow(1.0 - d * 2.0, mix(2.2, 1.15, bloomSoft));
            float fan = clamp(bloomHue, 0.0, 1.0);
            float slot = fract(vBand * 0.7 + vSeed * fan * 0.95 + vGain * 0.08);
            vec3 cLow = mix(color, color3, 0.4 * fan);
            vec3 cMid = mix(color3, color, 0.2);
            vec3 cHigh = mix(color, color2, 0.5 + 0.5 * fan);
            vec3 themed = mix(cLow, cMid, smoothstep(0.0, 0.55, slot));
            themed = mix(themed, cHigh, smoothstep(0.38, 1.0, slot) * fan);
            themed = mix(color, themed, 0.22 + fan * 0.78);
            vec3 hot = mix(themed, vec3(1.0, 0.94, 0.8), bloomWarm * (0.12 + vLive * 0.22 + vBand * 0.12));
            float twinkle = 0.72 + 0.28 * sin(time * (1.4 + vSeed * 3.2) + vSeed * 18.0);
            float spark = mix(1.0, twinkle, bloomSpark * (0.38 + vLive * 0.35));
            float bright = bloomBright * (1.08 + vLive * 0.28) * spark;
            gl_FragColor = vec4(hot * bright * glow, glow * vAlpha);
          }
        `,
      });
      this.bloomPoints = new THREE.Points(geo, mat);
      group.add(this.bloomPoints);
      return group;
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
        yaw: 0.35,
        prevKick: 0,
        preset: -1,
        trailAcc: 0,
        simulationTime: 0,
        cameraLocked: false,
      };
      const makeOrb = (index) => {
        const orb = new THREE.Group();
        const coreMaterial = new THREE.MeshBasicMaterial({
          color: 0x000000,
          depthTest: true,
          depthWrite: true,
          fog: false,
          toneMapped: false,
        });
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.64, 48, 36),
          coreMaterial
        );
        core.layers.enable(MAG_VOID_LAYER);
        core.renderOrder = -10;
        orb.add(core);
        orb.userData.core = core;
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
            varying vec3 vColor;
            varying float vAlpha;
            void main() {
              gl_FragColor = vec4(vColor * (0.8 + vAlpha * 0.75), vAlpha);
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
            gl_FragColor = vec4(hot * (0.72 + glow * 0.8 + core * 2.6 + star), a);
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
            varying vec3 vColor;
            varying float vAlpha;
            void main() {
              float edge = 0.7 + vAlpha * 0.6;
              gl_FragColor = vec4(vColor * edge, vAlpha);
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
        this.magnetosphereLines.material.clone()
      );
      this.magnetosphereSpikes.frustumCulled = false;

      const ringVerts = MAG_ATTRACTORS * MAG_RING_SEGS * 2;
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
        this.magnetosphereLines.material.clone()
      );
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
          varying float vAlpha;
          varying float vSeed;
          void main() {
            vec2 p = gl_PointCoord - 0.5;
            float d = length(p);
            if (d > 0.5) discard;
            float glow = pow(1.0 - d * 2.0, 1.85);
            vec3 tint = mix(color, color2, 0.42 + 0.34 * sin(time * 0.035 + vSeed * 5.0));
            gl_FragColor = vec4(tint * 0.52, glow * vAlpha);
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
            varying vec3 vWorldPos;
            ${SNOISE}
            void main() {
              vec3 ray = normalize(vWorldPos - cameraPosition);
              vec3 drift = vec3(time * 0.018, -time * 0.011, time * 0.014);
              float density = 0.0;
              float colorNoise = 0.0;
              for (int i = 0; i < 5; i++) {
                float fi = float(i);
                vec3 samplePos = cameraPosition * 0.14 + ray * (2.0 + fi * 2.1) + drift;
                float broad = snoise(samplePos * 0.31 + fi * 1.73);
                float detail = snoise(samplePos * 0.72 - drift * 1.4 + fi * 3.1);
                float cloud = smoothstep(0.03, 0.72, broad * 0.72 + detail * 0.28);
                density += cloud * (0.24 - fi * 0.024);
                colorNoise += detail * 0.09;
              }
              float horizon = 1.0 - smoothstep(0.22, 0.92, abs(ray.y));
              density *= 0.7 + horizon * 0.45;
              vec3 cool = mix(color2, color3, 0.24 + colorNoise);
              vec3 tint = mix(color * 0.72, cool, 0.34 + horizon * 0.16);
              float alpha = density * (0.035 + audioLevel * 0.014);
              gl_FragColor = vec4(tint * (0.22 + density * 0.16), alpha);
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
      this._analyse();
      this.elapsed += dt;
      this._updateLiveColor();
      if (this.uniforms) {
        this.uniforms.time.value = this.elapsed;
        this.uniforms.audioLevel.value = this.energy;
        this.uniforms.bass.value = this.smoothBass;
      }
      if (this.mode === "pulse" || this.mode === "bloom" || this.mode === "magnetosphere") {
        this._updateBands();
      }
      if (this.mode === "pulse") this._tickPulse(dt);
      if (this.mode === "ridge") this._tickRidge(dt);
      if (this.mode === "bloom") this._tickBloom(dt);
      if (this.mode === "magnetosphere") this._tickMagnetosphere(dt);
      this._updateCamera(dt);
      if (this.renderer) {
        if (this.mode === "magnetosphere" && this.magPost) {
          const preset = Math.max(0, this.mag?.preset || 0);
          const bloom = [1.32, 1.08, 0.92, 1.24][preset] || 1.18;
          const exposure = [1.08, 0.98, 1.04, 1.12][preset] || 1.05;
          this.magPost.render(this.scene, this.camera, {
            time: this.elapsed,
            threshold: preset === 2 ? 0.9 : 0.72,
            knee: 0.46,
            bloomStrength: bloom + this.kick * 0.16,
            exposure: exposure + this.energy * 0.08,
            saturation: preset === 2 ? 1.02 : 1.12,
            fineRadius: 1.15,
            mediumRadius: preset === 3 ? 2.35 : 1.9,
            veilRadius: preset === 0 ? 3.1 : 2.7,
            voidLayer: MAG_VOID_LAYER,
          });
        } else {
          this.renderer.setRenderTarget(null);
          this.renderer.render(this.scene, this.camera);
        }
      }
      this._drawWaveform();
    }

    _tickPulse(dt) {
      const spin = 0.12 + this.smoothBass * 0.55;
      this.pulse.rotation.y += dt * spin;
      this.pulse.rotation.x = Math.sin(this.elapsed * 0.35) * 0.12;
      const s = 1 + this.kick * 0.08 + this.smoothBass * 0.05;
      this.pulse.scale.setScalar(s);
      if (this.artMesh) this.artMesh.quaternion.copy(this.camera.quaternion);
      if (this.pulseDust) this.pulseDust.rotation.y -= dt * 0.04;
    }

    _tickRidge(dt) {
      this._syncRidgeIndex();
      this._syncRidgeHalo();
      const pos = this.ridgeGeo.attributes.position;
      const col = this.ridgeGeo.attributes.color;
      const arr = pos.array;
      const carr = col.array;
      const [r, g, b] = this.liveAccent;
      const step = this._ridgeStep || 1;
      this.ridgeAcc += dt;
      const interval = RIDGE_STEP * step;
      while (this.ridgeAcc >= interval) {
        this.ridgeAcc -= interval;
        for (let row = RIDGE_ROWS - 1; row >= step; row--) {
          if (row % step !== 0) continue;
          const srcRow = row - step;
          for (let c = 0; c < RIDGE_COLS; c++) {
            arr[(row * RIDGE_COLS + c) * 3 + 1] =
              arr[(srcRow * RIDGE_COLS + c) * 3 + 1];
          }
        }
      }
      const sense = clamp(this.params.sensitivity ?? 1, 0, 2.2);
      const react = Math.min(1, sense);
      for (let c = 0; c < RIDGE_COLS; c++) {
        const raw = this._bandMag(c / (RIDGE_COLS - 1));
        const hgt =
          raw * (1.75 + react * 0.3 + this.kick * 0.4 * react) * this.params.ridgeHeight;
        arr[c * 3 + 1] = hgt;
      }
      if (step > 1) {
        for (let row = 1; row < RIDGE_ROWS; row++) {
          if (row % step === 0) continue;
          for (let c = 0; c < RIDGE_COLS; c++) {
            arr[(row * RIDGE_COLS + c) * 3 + 1] = 0;
          }
        }
      }
      for (let row = 0; row < RIDGE_ROWS; row++) {
        const t = 1 - row / RIDGE_ROWS;
        const fade = 0.26 + 0.9 * Math.pow(t, 0.5);
        const heat = 0.18 * t;
        const drawn = row % step === 0;
        for (let c = 0; c < RIDGE_COLS; c++) {
          const i = (row * RIDGE_COLS + c) * 3;
          carr[i] = drawn ? Math.min(1.4, (r / 255) * fade + heat) : 0;
          carr[i + 1] = drawn ? Math.min(1.4, (g / 255) * fade + heat * 0.55) : 0;
          carr[i + 2] = drawn ? Math.min(1.4, (b / 255) * fade + heat * 0.2) : 0;
        }
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }

    _syncRidgeIndex() {
      if (!this.ridgeGeo) return;
      const freq = this.params.ridgeFreq ?? 1;
      const step = Math.max(1, Math.round(1 + (1 - freq) * 5));
      if (this._ridgeStep === step) return;
      this._ridgeStep = step;
      const index = [];
      for (let row = 0; row < RIDGE_ROWS; row += step) {
        for (let col = 0; col < RIDGE_COLS - 1; col++) {
          const i = row * RIDGE_COLS + col;
          index.push(i, i + 1);
        }
      }
      this.ridgeGeo.setIndex(index);
    }

    _syncRidgeHalo() {
      const thick = this.params.ridgeThick ?? 0.55;
      const fuzz = this.params.ridgeFuzz ?? 0.28;
      if (this.ridgeLineMat) {
        this.ridgeLineMat.opacity = 0.55 + (1 - fuzz) * 0.45;
      }
      const halos = this.ridgeHalos || [];
      const spread = 0.07 * thick * (0.5 + fuzz * 1.4);
      const used = Math.min(halos.length, Math.max(2, Math.round(thick * 8 + fuzz * 4)));
      for (let i = 0; i < halos.length; i++) {
        const halo = halos[i];
        const ring = Math.floor(i / 2) + 1;
        const sign = i % 2 === 0 ? 1 : -1;
        const on = i < used;
        halo.visible = on;
        halo.position.y = sign * spread * ring;
        halo.material.opacity = on
          ? (0.42 / Math.sqrt(ring)) * (0.35 + thick * 0.4) * (0.45 + fuzz * 0.55)
          : 0;
      }
    }

    _tickMagnetosphere(dt) {
      const mag = this.mag;
      if (!mag) return;
      const t = this.elapsed;
      const step = Math.min(0.025, dt);
      const simStep = this.magOptions.freeze ? 0 : step;
      mag.simulationTime += simStep;
      const simT = mag.simulationTime;
      const kickRise = Math.max(0, this.kick - mag.prevKick);
      mag.pulse = Math.max(kickRise * 2.4, mag.pulse * Math.exp(-step * 4.8));
      mag.prevKick = this.kick;
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
        const band = this._bandMag(orb.band);
        const targetCharge = orb.charge * (0.68 + band * 0.78 + mag.pulse * 0.24);
        orb.chargeStrength += (targetCharge - orb.chargeStrength) * (1 - Math.exp(-step * 2.2));
        if (simStep > 0) {
          const spring = i === 0 ? 0.48 : 0.31;
          let ax = (orb.target.x - orb.p.x) * spring;
          let ay = (orb.target.y - orb.p.y) * spring;
          let az = (orb.target.z - orb.p.z) * spring;
          for (let j = 0; j < mag.orbs.length; j++) {
            if (j === i) continue;
            const other = mag.orbs[j];
            const dx = orb.p.x - other.p.x;
            const dy = orb.p.y - other.p.y;
            const dz = orb.p.z - other.p.z;
            const d2 = dx * dx + dy * dy + dz * dz + 0.3;
            const inv = 1 / Math.sqrt(d2);
            const repel = 0.17 / d2;
            ax += dx * inv * repel;
            ay += dy * inv * repel;
            az += dz * inv * repel;
          }
          ax += Math.sin(simT * 0.31 + orb.phase) * band * 0.15;
          ay += Math.cos(simT * 0.27 + orb.phase) * band * 0.12;
          az += Math.sin(simT * 0.23 - orb.phase) * band * 0.14;
          orb.v.x += ax * simStep;
          orb.v.y += ay * simStep;
          orb.v.z += az * simStep;
          if (kickRise > 0.035) {
            orb.v.addScaledVector(orb.axis, kickRise * (0.65 + i * 0.08) * (i % 2 ? -1 : 1));
          }
          orb.v.multiplyScalar(Math.exp(-simStep * 0.64));
          if (orb.v.lengthSq() > 2.56) orb.v.setLength(1.6);
          orb.p.addScaledVector(orb.v, simStep);
        }
        const scale = orb.scale * (0.9 + band * 0.24 + mag.pulse * 0.11);
        orb.mesh.position.copy(orb.p);
        orb.mesh.scale.setScalar(scale);
        if (preset === 0) orb.mesh.visible = i < 3;
        else if (preset === 1) orb.mesh.visible = true;
        else if (preset === 2) orb.mesh.visible = false;
        else orb.mesh.visible = i < 2;
        orb.mesh.rotation.y += step * (0.08 + i * 0.025);
        orb.mesh.rotation.x = Math.sin(t * 0.09 + orb.phase) * 0.18;
      }

      this.magnetosphereMid.lerp(mag.center, 1 - Math.exp(-step * 1.7));
      mag.trailAcc += step;
      const sampleTrail = mag.trailAcc >= 1 / 30;
      if (sampleTrail) mag.trailAcc %= 1 / 30;
      if (simStep > 0) this._updateMagParticles(simStep, sampleTrail);
      this._updateMagRings();
      this.magnetosphereNebula.rotation.y += step * 0.009;
      this.magnetosphereNebula.rotation.x = Math.sin(t * 0.018) * 0.08;
      this.magnetosphereAtmo.rotation.y += step * 0.006;
      this.magnetosphereAtmo.rotation.z = Math.sin(t * 0.012) * 0.1;
    }

    _updateMagRings() {
      if (!this.magRingPos || !this.mag) return;
      const pos = this.magRingPos.array;
      const col = this.magRingCol.array;
      const alpha = this.magRingAlpha.array;
      const mag = this.mag;
      let vertex = 0;
      for (let i = 0; i < mag.orbs.length; i++) {
        const orb = mag.orbs[i];
        mag.ringN.crossVectors(orb.axis, mag.axis.set(0, 1, 0));
        if (mag.ringN.lengthSq() < 0.001) mag.ringN.set(1, 0, 0);
        mag.ringN.normalize();
        mag.ringB.crossVectors(orb.axis, mag.ringN).normalize();
        const tint = mag.palette[i % 3];
        const radius = orb.scale * (0.9 + (i % 2) * 0.45);
        for (let s = 0; s < MAG_RING_SEGS; s++) {
          for (let end = 0; end < 2; end++) {
            const u = (s + end) / MAG_RING_SEGS;
            const angle = u * Math.PI * 2 + this.elapsed * (0.035 + i * 0.008);
            const ca = Math.cos(angle);
            const sa = Math.sin(angle) * (0.52 + i * 0.04);
            const o = vertex * 3;
            pos[o] = orb.p.x + (mag.ringN.x * ca + mag.ringB.x * sa) * radius;
            pos[o + 1] = orb.p.y + (mag.ringN.y * ca + mag.ringB.y * sa) * radius;
            pos[o + 2] = orb.p.z + (mag.ringN.z * ca + mag.ringB.z * sa) * radius;
            col[o] = tint.r;
            col[o + 1] = tint.g;
            col[o + 2] = tint.b;
            alpha[vertex] = 0.06 + this.energy * 0.08;
            vertex++;
          }
        }
      }
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
      const shell = 0.42 + home.scale * (0.38 + this._magRandom() * 0.46);
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
          const radius = 0.64 * nearest.scale + 0.09;
          const rawD2 = Math.max(0, nearestD2 - 0.24);
          if (rawD2 < radius * radius) {
            mag.radial.subVectors(p.p, nearest.p);
            if (mag.radial.lengthSq() < 0.0001) mag.radial.set(1, 0, 0);
            mag.radial.normalize();
            const inward = p.v.dot(mag.radial);
            if (inward < 0) p.v.addScaledVector(mag.radial, -1.75 * inward);
            p.v.addScaledVector(mag.radial, 0.35 + live * 0.75);
            p.p.copy(nearest.p).addScaledVector(mag.radial, radius + 0.025);
            p.home = (p.home + 1 + ((p.seed * 17) | 0)) % mag.orbs.length;
            p.impactCooldown = 0.42;
            this._triggerMagImpact(p, live);
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
        hl[i] = life * (0.45 + hot * 0.55);

        if (i < MAG_SPIKES) {
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
            sa[vertex] = life * (end ? 0.035 + live * 0.24 : 0.08 + live * 0.36);
          }
        }

        for (let s = 0; s < MAG_TRAIL - 1; s++) {
          const trailFade = 1 - s / (MAG_TRAIL - 1);
          const alpha = life * trailFade * trailFade * (0.08 + hot * 0.42);
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

        if (i < MAG_RIBBONS) {
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
              (0.008 + p.size * 0.006 + live * 0.018) * profile * life * ribbonScale;
            const alpha = life * Math.pow(trailFade, 0.8) * profile * (0.024 + hot * 0.12);
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
      this.magLinePos.needsUpdate = true;
      this.magLineCol.needsUpdate = true;
      this.magLineAlpha.needsUpdate = true;
      this.magHeadPos.needsUpdate = true;
      this.magHeadCol.needsUpdate = true;
      this.magHeadSize.needsUpdate = true;
      this.magHeadLife.needsUpdate = true;
      this.magRibbonPos.needsUpdate = true;
      this.magRibbonCol.needsUpdate = true;
      this.magRibbonAlpha.needsUpdate = true;
      this.magSpikePos.needsUpdate = true;
      this.magSpikeCol.needsUpdate = true;
      this.magSpikeAlpha.needsUpdate = true;
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
          fp[o] = p.p.x;
          fp[o + 1] = p.p.y;
          fp[o + 2] = p.p.z;
          fs[i] = (4 + p.size * 1.8) * (0.55 + live * 1.4);
          fl[i] = (0.12 + live * live * 0.72) * Math.min(1, p.age * 2);
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
      if (u) {
        if (u.bloomReact) u.bloomReact.value = react;
        if (u.bloomShape) {
          u.bloomShape.value = clamp(
            p.bloomShape + drift(0.041, 0.07, 0.3) + drift(0.017, 0.035, 1.7),
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
        if (u.bloomBright) u.bloomBright.value = clamp(p.bloomBright * (1 + drift(0.015, 0.025, 1.1)), 0.58, 1.12);
        if (u.bloomTight) u.bloomTight.value = clamp(p.bloomTight + drift(0.014, 0.035, 0.9), 0, 1);
      }
      const spin = (p.bloomSpin ?? 1) * (1 + drift(0.012, 0.05, 0.5));
      this.bloomReact = react;
      this.bloom.rotation.y += dt * (0.09 + this.rawSmoothBass * 0.18 * react) * spin;
      this.bloom.rotation.z = Math.sin(t * 0.13) * 0.1 * (0.4 + spin * 0.5);
      this.bloom.scale.setScalar(1 + this.kick * 0.04 * react);
    }

    _updateBands() {
      const bins = 32;
      const data = this.bandData;
      if (!data) return;
      for (let i = 0; i < bins; i++) {
        const mag = this._bandMag(i / (bins - 1));
        const v = Math.min(255, mag * 255);
        const o = i * 4;
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
      const height = clamp(this.params.ridgeHeight || 1.15, 0.7, 2);
      const u = (zoom - 2.2) / 1.3;
      let magnetosphereCam = [0, 0.85, 4.8];
      if (this.mode === "magnetosphere" && this.mag) {
        this.mag.yaw += dt * (0.026 + this.energy * 0.012);
        const travel = 0.5 + 0.5 * Math.sin(this.elapsed * 0.019 - 0.8);
        const presetPull = [0, 1.65, 0.35, 1.05][Math.max(0, this.mag.preset)] || 0;
        const rad = Math.max(3.35, 7.35 - travel * 2.15 - presetPull - this.kick * 0.18);
        magnetosphereCam = [
          Math.sin(this.mag.yaw) * (1.15 + travel * 0.7),
          0.72 + Math.sin(this.elapsed * 0.037) * 1.15,
          Math.cos(this.mag.yaw * 0.32) * 0.42 + rad,
        ];
      }
      const targetFov = this.mode === "magnetosphere"
        ? [58, 52, 62, 66][Math.max(0, this.mag?.preset || 0)]
        : 60;
      const nextFov = this.camera.fov + (targetFov - this.camera.fov) * Math.min(1, dt * 0.7);
      if (Math.abs(nextFov - this.camera.fov) > 0.001) {
        this.camera.fov = nextFov;
        this.camera.updateProjectionMatrix();
      }
      const bloomReact = this.bloomReact ?? Math.min(1.12, this.params.sensitivity ?? 1);
      const bases = {
        pulse: [0, 0.35, 7.2],
        ridge: [0, 7.1 + height * 0.75 - u * 0.2, 11.2 - u * 1.4],
        bloom: [0, 1.55, 8.55 - bloomReact * 2.05],
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
      const look = new THREE.Vector3(0, 0, 0);
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
        figY = Math.sin(t * 0.2) * 1.15;
        figX = Math.sin(t * 0.09) * 0.42;
        look.set(0, figY * 0.18, 0);
      } else if (this.mode === "magnetosphere") {
        if (this.magnetosphereMid) look.copy(this.magnetosphereMid);
      }
      this.camera.position.set(
        this._camBase.x + figX,
        this._camBase.y + figY,
        this._camBase.z + figZ
      );
      this.camera.lookAt(look);
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

    _analyse() {
      const freq = this.freq;
      if (!freq.length) return;
      const n = freq.length;
      const bassN = Math.max(2, (n * 0.18) | 0);
      const midN = Math.max(bassN + 1, (n * 0.55) | 0);
      let bass = 0;
      let mid = 0;
      let high = 0;
      let peak = 0;
      for (let i = 0; i < n; i++) {
        const v = freq[i] / 255;
        if (v > peak) peak = v;
        if (i < bassN) bass += v;
        else if (i < midN) mid += v;
        else high += v;
      }
      bass /= bassN;
      mid /= midN - bassN;
      high /= Math.max(1, n - midN);
      this.dynPeak = Math.max(peak, (this.dynPeak || 0.28) * 0.995);
      this.dynGain = Math.min(2.2, 0.86 / Math.max(0.18, this.dynPeak));
      this.rawSmoothBass += (bass - (this.rawSmoothBass || 0)) * 0.18;
      bass = this._shape(bass);
      mid = this._shape(mid);
      high = this._shape(high);
      if (bass > this.smoothBass + 0.08) {
        this.kick = Math.min(1, (bass - this.smoothBass) * 3.6 + bass * 0.45);
      }
      this.kick *= 0.86;
      this.bass = bass;
      this.mid = mid;
      this.high = high;
      this.smoothBass += (bass - this.smoothBass) * 0.18;
      this.energy = Math.min(1.15, bass * 0.48 + mid * 0.34 + high * 0.18);
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
