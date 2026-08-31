"use strict";

(() => {
  const FULLSCREEN_VERTEX = `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `;

  class SCVizMagnetospherePost {
    constructor(renderer) {
      this.renderer = renderer;
      this.enabled = true;
      this.width = 0;
      this.height = 0;
      this.samples = -1;
      this.lastReflectionTime = -Infinity;
      this.type = THREE.HalfFloatType || THREE.UnsignedByteType;
      this.passScene = new THREE.Scene();
      this.passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
      this.quad.frustumCulled = false;
      this.passScene.add(this.quad);
      this._makeMaterials();
    }

    _makeMaterials() {
      this.brightMaterial = new THREE.ShaderMaterial({
        uniforms: {
          inputTex: { value: null },
          threshold: { value: 0.82 },
          knee: { value: 0.45 },
        },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: `
          uniform sampler2D inputTex;
          uniform float threshold;
          uniform float knee;
          varying vec2 vUv;
          void main() {
            vec3 color = texture2D(inputTex, vUv).rgb;
            float brightness = max(max(color.r, color.g), color.b);
            float soft = clamp((brightness - threshold + knee) / max(2.0 * knee, 0.0001), 0.0, 1.0);
            soft = soft * soft * knee;
            float contribution = max(soft, brightness - threshold) / max(brightness, 0.0001);
            gl_FragColor = vec4(color * max(contribution, 0.0), 1.0);
          }
        `,
      });

      // Progressive downsample, 13 taps (Jimenez, "Next Generation Post
      // Processing in Call of Duty: Advanced Warfare"). A single bilinear tap
      // per halving is a 2x2 box, which keeps fireflies and turns bright
      // points into blocks; this partitions the footprint into four
      // overlapping quads and is stable enough to chain many times.
      this.downMaterial = new THREE.ShaderMaterial({
        uniforms: { inputTex: { value: null }, texelSize: { value: new THREE.Vector2(1, 1) } },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: `
          uniform sampler2D inputTex;
          uniform vec2 texelSize;
          varying vec2 vUv;
          vec3 T(vec2 o) { return texture2D(inputTex, vUv + o * texelSize).rgb; }
          void main() {
            vec3 a = T(vec2(-2.0,  2.0));
            vec3 b = T(vec2( 0.0,  2.0));
            vec3 c = T(vec2( 2.0,  2.0));
            vec3 d = T(vec2(-2.0,  0.0));
            vec3 e = T(vec2( 0.0,  0.0));
            vec3 f = T(vec2( 2.0,  0.0));
            vec3 g = T(vec2(-2.0, -2.0));
            vec3 h = T(vec2( 0.0, -2.0));
            vec3 i = T(vec2( 2.0, -2.0));
            vec3 j = T(vec2(-1.0,  1.0));
            vec3 k = T(vec2( 1.0,  1.0));
            vec3 l = T(vec2(-1.0, -1.0));
            vec3 m = T(vec2( 1.0, -1.0));
            vec3 o = e * 0.125;
            o += (a + c + g + i) * 0.03125;
            o += (b + d + f + h) * 0.0625;
            o += (j + k + l + m) * 0.125;
            gl_FragColor = vec4(o, 1.0);
          }
        `,
      });

      // 3x3 tent upsample. Reading a w/32 texture with plain bilinear at full
      // resolution shows the interpolation diamonds; filtering back up the
      // chain a level at a time keeps it smooth.
      this.upMaterial = new THREE.ShaderMaterial({
        uniforms: {
          inputTex: { value: null },
          texelSize: { value: new THREE.Vector2(1, 1) },
          radius: { value: 1 },
        },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: `
          uniform sampler2D inputTex;
          uniform vec2 texelSize;
          uniform float radius;
          varying vec2 vUv;
          vec3 T(vec2 o) { return texture2D(inputTex, vUv + o * texelSize * radius).rgb; }
          void main() {
            vec3 o = T(vec2(-1.0,  1.0)) + T(vec2(0.0,  1.0)) * 2.0 + T(vec2(1.0,  1.0));
            o += T(vec2(-1.0,  0.0)) * 2.0 + T(vec2(0.0, 0.0)) * 4.0 + T(vec2(1.0, 0.0)) * 2.0;
            o += T(vec2(-1.0, -1.0)) + T(vec2(0.0, -1.0)) * 2.0 + T(vec2(1.0, -1.0));
            gl_FragColor = vec4(o * 0.0625, 1.0);
          }
        `,
      });

      this.compositeMaterial = new THREE.ShaderMaterial({
        uniforms: {
          sceneTex: { value: null },
          bloomHalf: { value: null },
          bloomQuarter: { value: null },
          bloomAura: { value: null },
          voidMaskTex: { value: null },
          bloomStrength: { value: 1.2 },
          exposure: { value: 1.08 },
          saturation: { value: 1.08 },
          time: { value: 0 },
          texelSize: { value: new THREE.Vector2(1, 1) },
        },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: `
          uniform sampler2D sceneTex;
          uniform sampler2D bloomHalf;
          uniform sampler2D bloomQuarter;
          uniform sampler2D bloomAura;
          uniform sampler2D voidMaskTex;
          uniform float bloomStrength;
          uniform float exposure;
          uniform float saturation;
          uniform float time;
          uniform vec2 texelSize;
          varying vec2 vUv;

          vec3 acesFilm(vec3 x) {
            float a = 2.51;
            float b = 0.03;
            float c = 2.43;
            float d = 0.59;
            float e = 0.14;
            return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
          }

          vec3 linearToSrgb(vec3 value) {
            vec3 low = value * 12.92;
            vec3 high = 1.055 * pow(max(value, 0.0), vec3(1.0 / 2.4)) - 0.055;
            return mix(low, high, step(vec3(0.0031308), value));
          }

          float hash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32 + time * 0.01);
            return fract(p.x * p.y);
          }

          vec3 sampleSoft(sampler2D tex, vec2 uv) {
            vec2 t = texelSize;
            vec3 c = texture2D(tex, uv).rgb * 0.36;
            c += texture2D(tex, uv + vec2(t.x, 0.0)).rgb * 0.16;
            c += texture2D(tex, uv - vec2(t.x, 0.0)).rgb * 0.16;
            c += texture2D(tex, uv + vec2(0.0, t.y)).rgb * 0.16;
            c += texture2D(tex, uv - vec2(0.0, t.y)).rgb * 0.16;
            return c;
          }

          void main() {
            vec3 raw = texture2D(sceneTex, vUv).rgb;
            vec3 sharp = mix(raw, sampleSoft(sceneTex, vUv), 0.62);
            vec3 fine = texture2D(bloomHalf, vUv).rgb;
            vec3 medium = texture2D(bloomQuarter, vUv).rgb;
            vec3 veil = texture2D(bloomAura, vUv).rgb;
            float voidMask = texture2D(voidMaskTex, vUv).r;
            float voidSolid = smoothstep(0.08, 0.92, voidMask);
            float voidCutout = 1.0 - voidSolid;
            vec3 bloom = bloomStrength * (fine * 0.68 + medium * 0.78 + veil * 0.54);
            vec3 color = sharp + bloom * voidCutout;
            color *= exposure;
            color = acesFilm(color);
            float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
            color = mix(vec3(luma), color, saturation);
            vec2 centered = vUv * 2.0 - 1.0;
            float vignette = 1.0 - smoothstep(0.38, 1.35, dot(centered, centered));
            color *= mix(0.68, 1.0, vignette);
            color = linearToSrgb(max(color, 0.0));
            float grain = (hash(gl_FragCoord.xy + time * 71.0) - 0.5) * 0.012;
            color += grain * (0.25 + 0.75 * (1.0 - luma)) * (1.0 - voidSolid);
            gl_FragColor = vec4(max(color, 0.0), 1.0);
          }
        `,
      });

      this.voidMaskMaterial = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      this.savedClearColor = new THREE.Color();
    }

    _target(width, height, depthBuffer = false, type = this.type, samples = 0) {
      const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer,
        stencilBuffer: false,
        samples,
      });
      target.texture.generateMipmaps = false;
      if (THREE.LinearSRGBColorSpace) target.texture.colorSpace = THREE.LinearSRGBColorSpace;
      return target;
    }

    /**
     * @param {number} samples MSAA samples for the scene target. The renderer's
     *   own `antialias: true` applies only to the default framebuffer, and this
     *   mode renders into a target instead -- so without this it is the one
     *   mode with no antialiasing at all, which is very visible on the thin
     *   additive lines it is mostly made of.
     */
    resize(width, height, samples = 0) {
      width = Math.max(2, Math.floor(width));
      height = Math.max(2, Math.floor(height));
      if (width === this.width && height === this.height && samples === this.samples) return;
      this.width = width;
      this.height = height;
      this.samples = samples;
      this.lastReflectionTime = -Infinity;
      this._disposeTargets();
      this.sceneTarget = this._target(width, height, true, this.type, samples);
      // The mask is thresholded with a smoothstep in the composite, so a hard
      // aliased edge here becomes a visibly jagged cutout around every dark
      // core. It is an RGBA8 target, so multisampling it is cheap.
      this.voidMaskTarget = this._target(width, height, false, THREE.UnsignedByteType, samples);
      this.reflectionTarget = this._target(Math.ceil(width / 2), Math.ceil(height / 2));
      // Strict halvings. The old chain went w/4 -> w/6, a 1.5x downscale taken
      // with one bilinear tap, which drops and duplicates texels and aliases by
      // construction.
      this.mips = [];
      for (let i = 0; i < 5; i++) {
        const d = 2 << i; // 2, 4, 8, 16, 32
        this.mips.push(this._target(Math.ceil(width / d), Math.ceil(height / d)));
      }
      this.fineScratch = this._target(Math.ceil(width / 2), Math.ceil(height / 2));
    }

    _draw(material, target) {
      this.quad.material = material;
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, false, false);
      this.renderer.render(this.passScene, this.passCamera);
    }

    _down(input, output) {
      const u = this.downMaterial.uniforms;
      u.inputTex.value = input.texture;
      u.texelSize.value.set(1 / input.width, 1 / input.height);
      this._draw(this.downMaterial, output);
    }

    _up(input, output, radius) {
      const u = this.upMaterial.uniforms;
      u.inputTex.value = input.texture;
      u.texelSize.value.set(1 / input.width, 1 / input.height);
      u.radius.value = radius;
      this._draw(this.upMaterial, output);
    }

    render(scene, camera, options = {}) {
      if (!this.enabled || !this.sceneTarget) {
        this.renderer.setRenderTarget(null);
        this.renderer.render(scene, camera);
        return;
      }
      const renderer = this.renderer;
      const previousTarget = renderer.getRenderTarget();
      const previousAutoClear = renderer.autoClear;
      const previousLayerMask = camera.layers.mask;
      renderer.autoClear = false;
      try {
        const reflectionTime = options.time ?? 0;
        if (
          reflectionTime < this.lastReflectionTime ||
          reflectionTime - this.lastReflectionTime >= 1 / 30
        ) {
          camera.layers.set(options.reflectionLayer ?? 0);
          renderer.setRenderTarget(this.reflectionTarget);
          renderer.clear(true, true, true);
          renderer.render(scene, camera);
          camera.layers.mask = previousLayerMask;
          this.lastReflectionTime = reflectionTime;
        }

        renderer.setRenderTarget(this.sceneTarget);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);

        const previousOverride = scene.overrideMaterial;
        const previousClearAlpha = renderer.getClearAlpha();
        renderer.getClearColor(this.savedClearColor);
        try {
          camera.layers.set(options.voidLayer ?? 30);
          scene.overrideMaterial = this.voidMaskMaterial;
          renderer.setClearColor(0x000000, 0);
          renderer.setRenderTarget(this.voidMaskTarget);
          renderer.clear(true, true, true);
          renderer.render(scene, camera);
        } finally {
          camera.layers.mask = previousLayerMask;
          scene.overrideMaterial = previousOverride;
          renderer.setClearColor(this.savedClearColor, previousClearAlpha);
        }

        const mips = this.mips;
        this.brightMaterial.uniforms.inputTex.value = this.sceneTarget.texture;
        this.brightMaterial.uniforms.threshold.value = options.threshold ?? 0.78;
        this.brightMaterial.uniforms.knee.value = options.knee ?? 0.42;
        this._draw(this.brightMaterial, mips[0]);

        for (let i = 1; i < mips.length; i++) this._down(mips[i - 1], mips[i]);

        // Every band is now produced by filtering back UP the pyramid, and
        // every kernel is compact: a 13-tap downsample or a 3x3 tent, always
        // at the resolution it was designed for.
        //
        // Nothing here uses a separable Gaussian any more. The old chain
        // stretched a 5-tap kernel to radius 2.65 and 4.2, putting its taps
        // +-13 texels apart -- horizontal pass draws five copies, vertical
        // pass draws five more, and the resulting 5x5 lattice is exactly the
        // hard square around every bright point. Even at radius 1 it ghosts on
        // an isolated star, because a single bright texel is not band-limited.
        //
        // Order matters: each level is read as a band's source before it is
        // reused as a coarser band's output.
        const fineRadius = Math.min(1.75, Math.max(0.75, options.fineRadius ?? 1.1));
        const mediumRadius = Math.min(1.75, Math.max(0.75, options.mediumRadius ?? 1.15));
        const veilRadius = Math.min(1.75, Math.max(0.75, options.veilRadius ?? 1.35));
        this._up(mips[1], this.fineScratch, fineRadius);
        this._up(mips[2], mips[1], mediumRadius);
        this._up(mips[4], mips[3], veilRadius);
        this._up(mips[3], mips[2], veilRadius);

        const composite = this.compositeMaterial.uniforms;
        composite.sceneTex.value = this.sceneTarget.texture;
        composite.bloomHalf.value = this.fineScratch.texture;
        composite.bloomQuarter.value = mips[1].texture;
        composite.bloomAura.value = mips[2].texture;
        composite.voidMaskTex.value = this.voidMaskTarget.texture;
        composite.bloomStrength.value = options.bloomStrength ?? 1.18;
        composite.exposure.value = options.exposure ?? 1.08;
        composite.saturation.value = options.saturation ?? 1.08;
        composite.time.value = options.time ?? 0;
        composite.texelSize.value.set(1 / this.sceneTarget.width, 1 / this.sceneTarget.height);
        this._draw(this.compositeMaterial, null);
      } catch (error) {
        this.enabled = false;
        console.warn("Soundstage: Magnetosphere HDR disabled", error);
        renderer.setRenderTarget(null);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
      } finally {
        camera.layers.mask = previousLayerMask;
        renderer.autoClear = previousAutoClear;
        if (previousTarget) renderer.setRenderTarget(previousTarget);
      }
    }

    _disposeTargets() {
      for (const name of ["sceneTarget", "voidMaskTarget", "reflectionTarget", "fineScratch"]) {
        this[name]?.dispose();
        this[name] = null;
      }
      if (this.mips) for (const m of this.mips) m.dispose();
      this.mips = null;
    }

    dispose() {
      this._disposeTargets();
      this.quad.geometry.dispose();
      this.brightMaterial.dispose();
      this.downMaterial.dispose();
      this.upMaterial.dispose();
      this.compositeMaterial.dispose();
      this.voidMaskMaterial.dispose();
    }

    releaseTargets() {
      this._disposeTargets();
      this.width = 0;
      this.height = 0;
      this.samples = -1;
      this.lastReflectionTime = -Infinity;
    }
  }

  globalThis.SCVizMagnetospherePost = SCVizMagnetospherePost;
})();
