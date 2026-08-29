# Contributing

## Load the extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** and choose this repository root

After changing content scripts, reload the extension **and** hard-refresh SoundCloud. The page-bridge runs in the page world; a SoundCloud refresh is required for audio-tap changes.

## Local lab (no SoundCloud)

Open `preview.html` (a local static server is enough):

```bash
python3 -m http.server 8765
# http://127.0.0.1:8765/preview.html
```

Drop an MP3, or use the synthetic audio fixtures. `H` hides the lab chrome. Query flags: `?mode=ridge&hide=1&seed=1831565813`.

## Layout

| Path | Role |
|---|---|
| `manifest.json` | MV3 extension manifest |
| `background.js` | Toggle command, tabCapture stream id, SoundCloud fetch proxy |
| `src/page-bridge.js` | MAIN-world AudioContext tap + client id |
| `src/content.js` | Overlay, play-bar button, comments, knobs |
| `src/visualizer.js` | Three.js modes + waveform |
| `src/magnetosphere-post.js` | Magnetosphere HDR bloom |
| `src/frame.js` | iframe scrape |
| `src/overlay.css` | Playing-mode UI |

Keep Magnetosphere changes isolated when you can. Bloom / Ridge / Pulse live mainly in `src/visualizer.js` and the overlay.

## Pull requests

- Keep the default path working on classic SoundCloud (play bar + waveform).
- Do not add analytics, remote scripts, or extra permissions without a clear need.
- If you change store-facing behavior, update `PRIVACY.md` and `store/LISTING.md`.
