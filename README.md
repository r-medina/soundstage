# SCViz

A Chrome extension that adds a visualizer / playing mode to SoundCloud.

While a track is playing, a button appears in the player bar (next to Like / Follow / Next up). Toggle it to cover the page with a visualizer. SoundCloud’s player bar stays put, and the track waveform stays on the bottom of the overlay with a live oscilloscope on top of it.

There are four WebGL visualizers:

- **Pulse** — a glowing wireframe orb that distorts with the music (Three.js / Codrops-style)
- **Ridge** — receding Joy Division–style spectrum mountains
- **Bloom** — a particle nebula that breathes with bass
- **Magnetosphere** — a cinematic recreation of Robert Hodgin's classic iTunes visualizer: 1,600 charged particles, long-lived hair and ribbon trails, light-absorbing black voids, volumetric atmosphere, star flares, and multi-scale HDR bloom

Cycle them from the HUD or with **V**. Comments can be shown or hidden — timed comments appear on the waveform, as bubbles, and in a list on the right.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Click **Load unpacked** and select this folder
4. Open [soundcloud.com](https://soundcloud.com), play a track, and click the visualizer button in the bottom player

Chrome may warn that the extension can capture tab audio. That’s only used to drive the visualizer, and only while playing mode is on.

## Use

- **Visualizer button** in the SoundCloud player bar, or the extension icon, or `Alt+V`
- **Esc** exits playing mode
- **V** cycles visualizers
- **C** toggles comments
- Click the bottom waveform (or a comment in the list) to seek

Comments show as avatars on the waveform, timed bubbles as the playhead hits them, and a list on the right.

## Files

```
manifest.json
background.js
src/page-bridge.js   # runs in the page, taps Web Audio + client id
src/content.js       # overlay, player button, comments, capture fallback
src/visualizer.js    # Three.js visualizers + waveform
src/magnetosphere-post.js # Magnetosphere HDR bloom + filmic tone mapping
src/vendor/three.min.js
src/overlay.css
preview.html         # deterministic Magnetosphere scene/audio lab
scripts/test-magnetosphere.js # long-run simulation and preset checks
icons/
```

Open `preview.html` directly to tune or inspect Magnetosphere without SoundCloud. The lab provides deterministic seeds, fixed scene presets, synthetic audio fixtures, camera/freeze controls, and PNG capture.
