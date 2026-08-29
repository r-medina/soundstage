# Privacy policy

**Effective date:** 29 August 2026  
**Product:** Soundstage (Chrome extension)

Soundstage is a visualizer / playing mode for [SoundCloud](https://soundcloud.com). It runs in your browser. It does not have its own accounts, analytics, or backend.

## What Soundstage does with data

Soundstage processes some information **on your device** so the visualizer, waveform, and comments can work. It does **not** send that information to the developer.

### Stored on your computer (`chrome.storage.local`)

Soundstage saves preferences such as:

- which visualizer is active
- comment and waveform visibility
- knob values (brightness, sensitivity, and similar)

This data stays in your Chrome profile. It is not uploaded.

### Audio (`tabCapture`)

When playing mode is on, Soundstage may capture audio from the SoundCloud tab. That audio is fed into the Web Audio API on the same tab to drive the visualizer (spectrum / waveform). The audio is not recorded, not stored, and not transmitted anywhere.

If SoundCloud’s own page already exposes an `AnalyserNode`, Soundstage prefers that and may not use tab capture.

### SoundCloud pages and APIs

Soundstage runs on `soundcloud.com` and related SoundCloud hosts. It reads the page (track title, artist, artwork, playback progress) and may request public SoundCloud resources needed for:

- the track waveform
- timed comments
- artwork used for color and the overlay

Those requests go to SoundCloud / SoundCloud CDNs, not to a developer-operated server. Comment text and avatars are shown in the overlay and are not stored by Soundstage except as needed for the current session.

## What Soundstage does not do

- No accounts, sign-in, or identity collection
- No advertising, tracking, or analytics SDKs
- No sale or sharing of user data
- No remote code execution
- No audio or browsing history sent to the developer

## Permissions in plain language

| Permission | Why |
|---|---|
| `storage` | Remember your visualizer and knob preferences |
| `tabCapture` | Read tab audio locally so the visuals can react to the music |
| Host access to SoundCloud / `sndcdn` / related hosts | Inject the overlay on SoundCloud and load waveform, comments, and artwork |

## Changes

If this policy changes, the date at the top will be updated and the new policy will apply to later versions of the extension.

## Contact

Open an issue on the public repository: [github.com/r-medina/soundstage](https://github.com/r-medina/soundstage).
