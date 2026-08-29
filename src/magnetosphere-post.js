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

      this.copyMaterial = new THREE.ShaderMaterial({
        uniforms: { inputTex: { value: null } },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: `
          uniform sampler2D inputTex;
          varying vec2 vUv;
          void main() {
            gl_FragColor = texture2D(inputTex, vUv);
          }
        `,
      });

      this.blurMaterial = new THREE.ShaderMaterial({
        uniforms: {
          inputTex: { value: null },
          direction: { value: new THREE.Vector2(1, 0) },
          texelSize: { value: new THREE.Vector2(1, 1) },
          radius: { value: 1 },
        },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: `
          uniform sampler2D inputTex;
          uniform vec2 direction;
          uniform vec2 texelSize;
          uniform float radius;
          varying vec2 vUv;
          void main() {
            vec2 stepUv = direction * texelSize * radius;
            vec3 color = texture2D(inputTex, vUv).rgb * 0.2270270270;
            color += texture2D(inputTex, vUv + stepUv * 1.3846153846).rgb * 0.3162162162;
            color += texture2D(inputTex, vUv - stepUv * 1.3846153846).rgb * 0.3162162162;
            color += texture2D(inputTex, vUv + stepUv * 3.2307692308).rgb * 0.0702702703;
            color += texture2D(inputTex, vUv - stepUv * 3.2307692308).rgb * 0.0702702703;
            gl_FragColor = vec4(color, 1.0);
          }
        `,
      });

      this.compositeMaterial = new THREE.ShaderMaterial({
        uniforms: {
          sceneTex: { value: null },
          bloomHalf: { value: null },
          bloomQuarter: { value: null },
          bloomEighth: { value: null },
          voidMaskTex: { value: null },
          bloomStrength: { value: 1.2 },
          exposure: { value: 1.08 },
          saturation: { value: 1.08 },
          time: { value: 0 },
        },
        depthTest: false,
        depthWrite: false,
        vertexShader: FULLSCREEN_VERTEX,
        fragmentShader: `
          uniform sampler2D sceneTex;
          uniform sampler2D bloomHalf;
          uniform sampler2D bloomQuarter;
          uniform sampler2D bloomEighth;
          uniform sampler2D voidMaskTex;
          uniform float bloomStrength;
          uniform float exposure;
          uniform float saturation;
          uniform float time;
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

          void main() {
            vec3 sharp = texture2D(sceneTex, vUv).rgb;
            vec3 fine = texture2D(bloomHalf, vUv).rgb;
            vec3 medium = texture2D(bloomQuarter, vUv).rgb;
            vec3 veil = texture2D(bloomEighth, vUv).rgb;
            float voidMask = texture2D(voidMaskTex, vUv).r;
            float voidSolid = smoothstep(0.08, 0.92, voidMask);
            float voidCutout = 1.0 - voidSolid;
            vec3 bloom = bloomStrength * (fine * 0.72 + medium * 0.62 + veil * 0.48);
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
            color += grain * (0.25 + 0.75 * (1.0 - luma));
            color *= 1.0 - voidSolid;
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

    _target(width, height, depthBuffer = false, type = this.type) {
      const target = new THREE.WebGLRenderTarget(Math.max(1, width), Math.max(1, height), {
        type,
        format: THREE.RGBAFormat,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        depthBuffer,
        stencilBuffer: false,
      });
      target.texture.generateMipmaps = false;
      if (THREE.LinearSRGBColorSpace) target.texture.colorSpace = THREE.LinearSRGBColorSpace;
      return target;
    }

    resize(width, height) {
      width = Math.max(2, Math.floor(width));
      height = Math.max(2, Math.floor(height));
      if (width === this.width && height === this.height) return;
      this.width = width;
      this.height = height;
      this._disposeTargets();
      this.sceneTarget = this._target(width, height, true);
      this.voidMaskTarget = this._target(width, height, false, THREE.UnsignedByteType);
      if (this.renderer.capabilities.isWebGL2) {
        this.sceneTarget.samples = 4;
        this.voidMaskTarget.samples = 4;
      }
      this.halfA = this._target(Math.ceil(width / 2), Math.ceil(height / 2));
      this.halfB = this._target(Math.ceil(width / 2), Math.ceil(height / 2));
      this.quarterA = this._target(Math.ceil(width / 4), Math.ceil(height / 4));
      this.quarterB = this._target(Math.ceil(width / 4), Math.ceil(height / 4));
      this.eighthA = this._target(Math.ceil(width / 8), Math.ceil(height / 8));
      this.eighthB = this._target(Math.ceil(width / 8), Math.ceil(height / 8));
    }

    _draw(material, target) {
      this.quad.material = material;
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, false, false);
      this.renderer.render(this.passScene, this.passCamera);
    }

    _blur(input, scratch, output, radius) {
      const uniforms = this.blurMaterial.uniforms;
      uniforms.inputTex.value = input.texture;
      uniforms.texelSize.value.set(1 / input.width, 1 / input.height);
      uniforms.direction.value.set(1, 0);
      uniforms.radius.value = radius;
      this._draw(this.blurMaterial, scratch);
      uniforms.inputTex.value = scratch.texture;
      uniforms.texelSize.value.set(1 / scratch.width, 1 / scratch.height);
      uniforms.direction.value.set(0, 1);
      this._draw(this.blurMaterial, output);
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
      renderer.autoClear = false;
      try {
        renderer.setRenderTarget(this.sceneTarget);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);

        const previousLayerMask = camera.layers.mask;
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

        this.brightMaterial.uniforms.inputTex.value = this.sceneTarget.texture;
        this.brightMaterial.uniforms.threshold.value = options.threshold ?? 0.78;
        this.brightMaterial.uniforms.knee.value = options.knee ?? 0.42;
        this._draw(this.brightMaterial, this.halfA);
        this._blur(this.halfA, this.halfB, this.halfA, options.fineRadius ?? 1.15);

        this.copyMaterial.uniforms.inputTex.value = this.halfA.texture;
        this._draw(this.copyMaterial, this.quarterA);
        this._blur(this.quarterA, this.quarterB, this.quarterA, options.mediumRadius ?? 1.9);

        this.copyMaterial.uniforms.inputTex.value = this.quarterA.texture;
        this._draw(this.copyMaterial, this.eighthA);
        this._blur(this.eighthA, this.eighthB, this.eighthA, options.veilRadius ?? 2.7);

        const composite = this.compositeMaterial.uniforms;
        composite.sceneTex.value = this.sceneTarget.texture;
        composite.bloomHalf.value = this.halfA.texture;
        composite.bloomQuarter.value = this.quarterA.texture;
        composite.bloomEighth.value = this.eighthA.texture;
        composite.voidMaskTex.value = this.voidMaskTarget.texture;
        composite.bloomStrength.value = options.bloomStrength ?? 1.18;
        composite.exposure.value = options.exposure ?? 1.08;
        composite.saturation.value = options.saturation ?? 1.08;
        composite.time.value = options.time ?? 0;
        this._draw(this.compositeMaterial, null);
      } catch (error) {
        this.enabled = false;
        console.warn("SCViz: Magnetosphere HDR disabled", error);
        renderer.setRenderTarget(null);
        renderer.clear(true, true, true);
        renderer.render(scene, camera);
      } finally {
        renderer.autoClear = previousAutoClear;
        if (previousTarget) renderer.setRenderTarget(previousTarget);
      }
    }

    _disposeTargets() {
      for (const name of [
        "sceneTarget",
        "voidMaskTarget",
        "halfA",
        "halfB",
        "quarterA",
        "quarterB",
        "eighthA",
        "eighthB",
      ]) {
        this[name]?.dispose();
        this[name] = null;
      }
    }

    dispose() {
      this._disposeTargets();
      this.quad.geometry.dispose();
      this.brightMaterial.dispose();
      this.copyMaterial.dispose();
      this.blurMaterial.dispose();
      this.compositeMaterial.dispose();
      this.voidMaskMaterial.dispose();
    }
  }

  globalThis.SCVizMagnetospherePost = SCVizMagnetospherePost;
})();
