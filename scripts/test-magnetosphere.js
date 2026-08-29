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
    bass: { value: 0.5 },
    color: { value: new THREE.Color() },
    color2: { value: new THREE.Color() },
    color3: { value: new THREE.Color() },
  };
  viz.camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 260);
  viz.camera.position.set(0, 0.8, 6);
  viz.liveAccent = [100, 255, 70];
  viz.liveAccent2 = [255, 70, 190];
  viz.freq = new Uint8Array(256).fill(150);
  viz.params = { sensitivity: 1 };
  viz.dynGain = 1;
  viz.energy = 0.6;
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
assert.equal(post.voidMaskTarget.samples, 4);
assert.ok(post.compositeMaterial.uniforms.voidMaskTex);
post.dispose();
run(a, 1200);
run(b, 1200);

assert.equal(a.mag.particles.length, 1600);
assert.equal(a.magLinePos.count, 1600 * (42 - 1) * 2);
assert.ok(a.mag.particles.every((p) => Number.isFinite(p.p.x + p.p.y + p.p.z)));
for (const orb of a.mag.orbs) {
  assert.equal(orb.mesh.children.length, 1);
  assert.equal(orb.mesh.userData.core.material.isMeshBasicMaterial, true);
  assert.equal(orb.mesh.userData.core.material.color.getHex(), 0x000000);
  assert.equal(orb.mesh.userData.core.material.toneMapped, false);
  assert.equal(orb.mesh.userData.core.material.transparent, false);
  assert.equal(orb.mesh.userData.core.layers.test(voidLayer), true);
}
for (let i = 0; i < a.mag.particles.length; i++) {
  assert.equal(a.mag.particles[i].p.distanceToSquared(b.mag.particles[i].p), 0);
}

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

console.log(
  JSON.stringify({
    ok: true,
    particles: a.mag.particles.length,
    trailVertices: a.magLinePos.count,
    flareEvents: a.mag.flareEvents.length,
    voidCores: a.mag.orbs.length,
    presetSummary,
  })
);
