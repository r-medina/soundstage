# Chrome Web Store listing copy

Paste these fields into the [Chrome Developer Dashboard](https://chrome.google.com/webstore/devconsole).  
Assets live in `store/promo/` and `store/screenshots/`.

This extension is **not affiliated with SoundCloud**. Do not upload the SoundCloud logo or claim endorsement.

## Product details

**Name** (max 45 characters)

```
SCViz – SoundCloud visualizer
```

**Summary** (max 132 characters)

```
Full-screen playing mode for SoundCloud: Pulse, Ridge, Bloom, and Magnetosphere visualizers, plus the waveform and comments.
```

**Category:** Fun  
**Language:** English  
**Mature content:** No

**Homepage URL** (after the GitHub repo is public)

```
https://github.com/r-medina/scviz
```

**Support URL**

```
https://github.com/r-medina/scviz/issues
```

**Official URL:** leave empty unless you verify a site in Search Console.

## Detailed description

```
SCViz turns SoundCloud into a playing mode. While a track is playing, open it from the player bar. The page becomes a full-screen visualizer. The SoundCloud play bar stays. The waveform stays at the bottom, with a live oscilloscope over it.

Four visualizers

• Pulse — a glowing wireframe orb that bends with the music
• Ridge — receding spectrum ridges, Joy Division–style
• Bloom — a particle nebula that breathes with bass
• Magnetosphere — a cinematic take on the classic iTunes visualizer: charged particles, trails, black cores, atmosphere

Cycle visualizers with V, or from the HUD. Hide comments, hide the waveform, or open knobs (T) to tune the active mode.

Comments

Timed comments can sit on the waveform, pop as bubbles, and list on the right. Turn them off with C.

Audio

SCViz reads audio in the tab so the visuals can follow the music. Capture stays in the browser. Nothing is uploaded.

Privacy

No accounts. No analytics. Preferences stay in chrome.storage.local. See the privacy policy on the GitHub repository.

This project is unofficial and is not affiliated with, endorsed, or sponsored by SoundCloud Ltd.
```

## Graphic assets

| Asset | File | Size |
|---|---|---|
| Store icon | `icons/icon128.png` | 128×128 |
| Small promo tile (**required**) | `store/promo/small-tile.png` | 440×280 |
| Marquee promo tile (optional) | `store/promo/marquee.png` | 1400×560 |
| Screenshot 1 | `store/screenshots/01-pulse.png` | 1280×800 |
| Screenshot 2 | `store/screenshots/02-ridge.png` | 1280×800 |
| Screenshot 3 | `store/screenshots/03-bloom.png` | 1280×800 |
| Screenshot 4 | `store/screenshots/04-magnetosphere.png` | 1280×800 |

Screenshot captions (optional, in dashboard order):

1. Pulse — wireframe orb  
2. Ridge — receding spectrum  
3. Bloom — particle nebula  
4. Magnetosphere — charged cores and trails  

The four stills are lab captures of the visualizers. Reviewers prefer at least one shot of the **extension on soundcloud.com** (play bar button + overlay). Take that on your machine after loading unpacked, then replace or add it as screenshot 5.

**YouTube video:** recommended. Record 20–40s of playing mode on a real track. Shorts-style is fine.

## Privacy practices tab

### Single purpose

```
Add a full-screen music visualizer / playing mode to SoundCloud, including optional waveform and comments.
```

### Permission justifications

**storage**

```
Saves the user's visualizer mode, comment/waveform visibility, and knob values in chrome.storage.local so settings persist between sessions. Data never leaves the device.
```

**tabCapture**

```
Captures audio from the SoundCloud tab so the visualizer can react to the playing track. Audio is analysed locally with the Web Audio API and is not recorded, stored, or transmitted. Used only while playing mode is on.
```

**Host permission: `https://soundcloud.com/*`, `https://*.soundcloud.com/*`**

```
Injects the playing-mode overlay and player-bar button on SoundCloud, and reads the currently playing track from the page.
```

**Host permission: `https://*.sndcdn.com/*`, `https://*.soundcloud.cloud/*`, `https://graph.soundcloud.com/*`**

```
Loads public waveform data, timed comments, and artwork for the current track so the overlay can show the waveform, comment markers, and accent color. Requests go to SoundCloud infrastructure only.
```

### Remote code

Select: **No, I am not using remote code.**

All scripts ship in the extension package (`src/vendor/three.min.js` included).

### Data use

Check **none** of the collection categories if the form allows “I do not collect user data,” **or** if you must pick something closest to local-only:

- Do **not** check personally identifiable information, health, financial, authentication, location, web history, user activity, website content — SCViz does not collect these for the developer.
- Local preferences and in-tab audio analysis are not sent off-device.

Certify limited use / no sale of data / no use for unrelated purposes. All true.

### Privacy policy URL

After the repo is public:

```
https://github.com/r-medina/scviz/blob/main/PRIVACY.md
```

Google needs this URL to load without auth. `blob/main/PRIVACY.md` on a public repo is enough. A GitHub Pages copy is optional.

## Distribution

- Visibility: **Public**
- Regions: all, unless you have a reason to restrict
- Pricing: **Free**
