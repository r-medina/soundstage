"use strict";

const assert = require("node:assert/strict");
const THREE = require("../src/vendor/three.min.js");

global.THREE = THREE;
require("../src/magnetosphere-post.js");
require("../src/visualizer.js");

function makeVisualizer(seed, preset) {
  const viz = Object.create(global.SCVizVisualizer.prototype);
  viz.uniforms = {
    time: { value: 0 },
    audioLevel: { value: 0.5 },
    loudness: { value: 0.55 },
    loudGlow: { value: 0.85 },
    bass: { value: 0.5 },
    color: { value: new THREE.Color() },
    color2: { value: new THREE.Color() },
    color3: { value: new THREE.Color() },
    magReflectivity: { value: 0 },
    magReflectionTex: { value: null },
    magVoidGlow: { value: 0.12 },
    magTrail: { value: 1 },
    magAtmosphere: { value: 1 },
  };
  viz.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 260);
  viz.camera.position.set(0, 0.8, 6);
  viz.liveAccent = [100, 255, 70];
  viz.liveAccent2 = [255, 70, 190];
  viz.freq = new Uint8Array(256).fill(150);
  viz.time = new Uint8Array(512).fill(128);
  viz.params = {
    sensitivity: 1,
    loudGlow: 0.85,
    magReflect: 0.04,
    magReflectAuto: 0.52,
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
  viz.dynGain = 1;
  viz.energy = 0.6;
  viz.loudness = 0.55;
  viz.integratedPower = 0;
  viz.powerFast = 0;
  viz.powerSlow = 0;
  viz.smoothBass = 0.5;
  viz.kick = 0.2;
  viz.elapsed = 0;
  viz.magSeed = seed >>> 0;
  viz.magOptions = { forcedPreset: preset, freeze: false, cameraLock: false };
  viz.magnetosphere = viz._makeMagnetosphere();
  return viz;
}

function run(viz, frames) {
  for (let frame = 0; frame < frames; frame++) {
    viz.elapsed += 1 / 60;
    viz.kick = frame % 43 === 0 ? 0.8 : 0.15;
    viz._tickMagnetosphere(1 / 60);
  }
}

const seed = 0x6d2b79f5;
const a = makeVisualizer(seed, 0);
const b = makeVisualizer(seed, 0);
const voidLayer = new THREE.Layers();
voidLayer.set(30);
const post = new global.SCVizMagnetospherePost({ capabilities: { isWebGL2: true } });
post.resize(1280, 720);
assert.equal(post.voidMaskTarget.width, 1280);
assert.equal(post.voidMaskTarget.height, 720);
assert.equal(post.voidMaskTarget.samples, 0);
assert.equal(post.reflectionTarget.width, 640);
assert.equal(post.reflectionTarget.height, 360);
assert.ok(post.compositeMaterial.uniforms.voidMaskTex);
assert.equal(post.eighthA.width, 160);
post.releaseTargets();
assert.equal(post.sceneTarget, null);
assert.equal(post.width, 0);
post.dispose();
run(a, 1200);
run(b, 1200);

assert.equal(a.mag.particles.length, 1600);
assert.equal(a.magLinePos.count, 1600 * (42 - 1) * 2);
assert.ok(a.mag.geometryBuilds >= 850 && a.mag.geometryBuilds <= 950);
assert.ok(a.mag.particles.every((p) => Number.isFinite(p.p.x + p.p.y + p.p.z)));
for (const orb of a.mag.orbs) {
  assert.equal(orb.mesh.children.length, 2);
  assert.equal(orb.mesh.userData.core.material.isShaderMaterial, true);
  assert.ok(orb.mesh.userData.core.material.uniforms.magReflectivity);
  assert.ok(orb.mesh.userData.core.material.uniforms.magReflectionTex);
  assert.ok(orb.mesh.userData.halo.material.uniforms.magVoidGlow);
  assert.equal(orb.mesh.userData.core.material.toneMapped, false);
  assert.equal(orb.mesh.userData.core.material.transparent, false);
  assert.equal(orb.mesh.userData.core.layers.test(voidLayer), true);
}
assert.ok(a.mag.density >= 0.08 && a.mag.density <= 1);
assert.ok(a.magReflectivity >= 0 && a.magReflectivity <= 1);

const audioProbe = makeVisualizer(seed, 0);
const freqBuffer = audioProbe.freq;
const timeBuffer = audioProbe.time;
audioProbe.setAudio(new Uint8Array(256).fill(44), new Uint8Array(512).fill(129));
assert.equal(audioProbe.freq, freqBuffer);
assert.equal(audioProbe.time, timeBuffer);
assert.equal(audioProbe.freq[0], 44);
for (let i = 0; i < a.mag.particles.length; i++) {
  assert.equal(a.mag.particles[i].p.distanceToSquared(b.mag.particles[i].p), 0);
}

const loudnessProbe = makeVisualizer(seed, 0);
loudnessProbe.loudness = 0;
loudnessProbe.freq.fill(18);
for (let i = 0; i < 60; i++) loudnessProbe._analyse();
const quietLoudness = loudnessProbe.loudness;
loudnessProbe.freq.fill(235);
for (let i = 0; i < 30; i++) loudnessProbe._analyse();
assert.ok(loudnessProbe.integratedPower > 0.7);
assert.ok(loudnessProbe.loudness > quietLoudness + 0.3);

const pulseProbe = makeVisualizer(seed, 0);
pulseProbe.pulse = pulseProbe._makePulse();
pulseProbe.pulse.rotation.set(0.42, 0.91, -0.18);
pulseProbe.smoothBass = 0.8;
pulseProbe.kick = 0.75;
pulseProbe._tickPulse(1 / 60);
pulseProbe._updatePulseArtwork();
const pulseSurface = pulseProbe.pulse.children[1];
assert.equal(pulseSurface.material.depthWrite, true);
assert.equal(pulseSurface.material.side, THREE.DoubleSide);
assert.ok(pulseProbe.artMesh.scale.x > 1);
const artWorldQuat = new THREE.Quaternion();
const cameraWorldQuat = new THREE.Quaternion();
pulseProbe.artMesh.getWorldQuaternion(artWorldQuat);
pulseProbe.camera.getWorldQuaternion(cameraWorldQuat);
assert.ok(Math.abs(artWorldQuat.dot(cameraWorldQuat)) > 0.999999);

const presetSummary = [];
for (let preset = 0; preset < 4; preset++) {
  const viz = makeVisualizer(seed, preset);
  run(viz, 180);
  assert.equal(viz.mag.preset, preset);
  assert.ok(viz.magRingPos.array.every(Number.isFinite));
  assert.ok(viz.magSpikePos.array.every(Number.isFinite));
  presetSummary.push({
    preset,
    hairs: viz.magnetosphereLines.geometry.drawRange.count,
    ribbons: viz.magnetosphereRibbons.geometry.drawRange.count,
    spikes: viz.magnetosphereSpikes.geometry.drawRange.count,
    visibleCores: viz.mag.orbs.filter((orb) => orb.mesh.visible).length,
  });
}

const stress = makeVisualizer(seed ^ 0x9e3779b9, 3);
Object.assign(stress.params, {
  loudGlow: 2,
  magReflect: 1,
  magReflectAuto: 1,
  magVoidGlow: 1,
  magDensity: 1,
  magDensityAuto: 1,
  magTrail: 2.5,
  magRibbon: 2.5,
  magAtmosphere: 2,
  magBloom: 2,
  magMotion: 2,
  magCoreSize: 1.6,
});
stress.uniforms.loudGlow.value = 2;
stress.uniforms.magTrail.value = 2.5;
stress.uniforms.magAtmosphere.value = 2;
run(stress, 1200);
assert.ok(stress.mag.particles.every((p) => Number.isFinite(p.p.x + p.p.y + p.p.z)));
assert.ok(stress.mag.density >= 0.08 && stress.mag.density <= 1);

console.log(
  JSON.stringify({
    ok: true,
    particles: a.mag.particles.length,
    trailVertices: a.magLinePos.count,
    flareEvents: a.mag.flareEvents.length,
    voidCores: a.mag.orbs.length,
    geometryBuilds: a.mag.geometryBuilds,
    stressFinite: true,
    presetSummary,
  })
);
