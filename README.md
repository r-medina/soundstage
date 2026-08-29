# SCViz

A Chrome extension that adds a visualizer / playing mode to SoundCloud.

While a track is playing, a button appears in the player bar (next to Like / Follow / Next up). Toggle it to cover the page with a visualizer. SoundCloud’s player bar stays put, and the track waveform stays on the bottom of the overlay with a live oscilloscope on top of it.

There are four WebGL visualizers:

- **Pulse** — a glowing wireframe orb that distorts with the music (Three.js / Codrops-style)
- **Ridge** — receding Joy Division–style spectrum mountains
- **Bloom** — a particle nebula that breathes with bass while its ring plane banks and the camera orbits, rises, and dives through the field
- **Magnetosphere** — a cinematic recreation of Robert Hodgin's classic iTunes visualizer: 1,600 charged particles, long-lived hair and ribbon trails, light-absorbing black voids, live streak reflections, volumetric atmosphere, star flares, and three-scale HDR bloom

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

The knobs tray includes a global loudness-glow response plus mode-specific controls. Magnetosphere exposes reflectivity and automatic reflection flow, a subtle void halo, particle density and density flow, trail/ribbon intensity, atmosphere, bloom, motion, and core size. Its voids remain black at zero reflectivity, while the optional halo just reveals their silhouette; when reflectivity rises, they mirror the live streak field rather than a fixed highlight. Ridge height ranges up to 4.5.

Magnetosphere keeps its cinematic three-scale bloom and full-resolution void edges, but avoids multisampled HDR buffers, releases its render targets when inactive, reuses audio buffers, and adaptively lowers internal resolution only after sustained slow frames. The local lab reports frame time, quality scale, render resolution, and draw calls.

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

Open `preview.html` directly to tune or inspect the visualizers without SoundCloud. Click **Load song**—the modern Chrome picker starts in Downloads—or drag an MP3 onto the page. The lab uses a real Web Audio analyser and also provides synthetic fixtures, deterministic seeds, visualizer switching, PNG capture, and every tuning control from the extension. It shows only global controls plus those belonging to the active visualizer; Magnetosphere additionally exposes its presets, seed, camera lock, and freeze controls.
