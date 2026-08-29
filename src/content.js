"use strict";

(() => {
  const PLAYBAR_BTN_CLASS = "scviz-playbar-btn";
  const MODES = () => SCVizVisualizer.modes;
  const REDUCED_MOTION = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const ENTER_TRANSITION_MS = REDUCED_MOTION ? 80 : 920;
  const EXIT_TRANSITION_MS = REDUCED_MOTION ? 80 : 760;

  const state = {
    on: false,
    commentsOn: true,
    waveOn: true,
    mode: "pulse",
    clientId: "",
    oauth: "",
    trackId: "",
    trackKey: "",
    track: {
      title: "",
      artist: "",
      url: "",
      artwork: "",
      duration: 1,
    },
    samples: [],
    comments: [],
    commentStatus: "",
    lastToastAt: 0,
    lastToastId: "",
    capture: null,
    tapAliveAt: 0,
    captureTried: false,
    viz: null,
    raf: 0,
    transitionTimer: 0,
    transitionEpoch: 0,
    accent: [255, 85, 0],
    params: {
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
      ridgeFreq: 1,
      ridgeFuzz: 0.28,
      pulseArt: 1,
      sensitivity: 1,
      loudGlow: 0.85,
      magReflect: 0.52,
      magVoidGlow: 0.12,
      magDensity: 0.88,
      magDensityAuto: 0.58,
      magTrail: 1,
      magRibbon: 1,
      magAtmosphere: 1,
      magBloom: 1,
      magMotion: 1,
      magCoreSize: 1,
    },
  };

  let root;
  let canvas;
  let waveCanvas;
  let artBg;
  let artDisc;
  let titleEl;
  let artistEl;
  let commentsBtn;
  let waveBtn;
  let knobsBtn;
  let modeBtn;
  let dotsEl;
  let toastsEl;
  let railEl;
  let playbarObserver;
  let trackObserver;
  let trackTimer;
  let hintTimer;
  let chromeTimer;

  boot();

  function alive() {
    try {
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch {
      return false;
    }
  }

  function isInvalidated(err) {
    const msg = String(err?.message || err);
    return /Extension context invalidated/i.test(msg) || /specified extension context/i.test(msg);
  }

  function isBenignCaptureError(err) {
    const msg = String(err?.message || err);
    return (
      isInvalidated(err) ||
      /not been invoked/i.test(msg) ||
      /activeTab/i.test(msg) ||
      /cannot be captured/i.test(msg) ||
      /no stream id/i.test(msg)
    );
  }

  function shutdown() {
    try {
      clearTimeout(state.transitionTimer);
      setPageAudioActive(false);
      cancelAnimationFrame(state.raf);
      if (trackTimer) clearInterval(trackTimer);
      playbarObserver?.disconnect();
      trackObserver?.disconnect();
      state.viz?.stop();
      teardownCapture();
    } catch {
      // stale extension world
    }
  }

  function guard(fn) {
    return function guarded(...args) {
      if (!alive()) {
        shutdown();
        return;
      }
      try {
        return fn.apply(this, args);
      } catch (err) {
        if (isInvalidated(err)) {
          shutdown();
          return;
        }
        throw err;
      }
    };
  }

  function boot() {
    if (!alive()) return;
    try {
      chrome.storage.local.get(
        { commentsOn: true, waveOn: true, mode: "pulse", params: {} },
        (stored) => {
          if (!alive() || !stored) return;
          state.commentsOn = stored.commentsOn !== false;
          state.waveOn = stored.waveOn !== false;
          if (stored.mode) state.mode = stored.mode;
          if (stored.params && typeof stored.params === "object") {
            const params = { ...stored.params };
            const reflectFlow = Number(params.magReflectAuto);
            if (Number.isFinite(reflectFlow)) {
              const reflectBase = Number(params.magReflect);
              params.magReflect = Math.min(
                1,
                Math.max(0, (Number.isFinite(reflectBase) ? reflectBase : 0) + reflectFlow)
              );
              delete params.magReflectAuto;
            }
            Object.assign(state.params, params);
          }
          state.params = clampParams(state.params);
          if (state.viz) state.mode = state.viz.setMode(state.mode);
          state.viz?.setParams(state.params);
          applyCommentMode();
          applyWaveMode();
          syncModeButton();
          syncDisc();
          syncTray();
        }
      );
      chrome.runtime.onMessage.addListener(
        guard((message) => {
          if (message?.type === "scviz-toggle") toggle();
        })
      );
    } catch (err) {
      if (isInvalidated(err)) return;
      throw err;
    }

    window.addEventListener("message", guard(onPageMessage));
    document.addEventListener("keydown", guard(onKey), true);

    watchPlaybar();
    watchTrack();
  }

  function onPageMessage(event) {
    const data = event.data;
    if (!data) return;
    if (data.source === "scviz") {
      if (data.type === "client-id" && data.id) state.clientId = data.id;
      if (data.type === "oauth" && data.token) state.oauth = data.token;
      if (data.type === "track-id" && data.id) {
        if (data.id !== state.trackId) {
          state.trackId = data.id;
          if (state.on) refreshTrackData();
        } else {
          state.trackId = data.id;
        }
      }
      if (data.type === "audio") {
        state.tapAliveAt = performance.now();
        if (state.on && !state.capture) state.viz?.setAudio(data.freq, data.time);
      }
      return;
    }
    if (data.source === "scviz-frame") {
      if (data.trackUrl) maybeSetTrackUrl(data.trackUrl);
      if (data.samples?.length && !state.samples.length) {
        state.samples = data.samples;
        state.viz?.setWaveform(data.samples);
      }
      if (data.comments?.length) mergeComments(data.comments);
    }
  }

  function maybeSetTrackUrl(url) {
    const canonical = canonicalTrackUrl(url);
    if (!canonical) return;
    if (!state.track.url || /\/undefined\//.test(state.track.url)) {
      state.track.url = canonical;
    }
  }

  function onKey(event) {
    if (!state.on) return;
    if (event.target?.closest?.("input, textarea, [contenteditable]")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      setOn(false);
    } else if (event.key === "c" || event.key === "C") {
      event.preventDefault();
      setCommentsOn(!state.commentsOn);
    } else if (event.key === "w" || event.key === "W") {
      event.preventDefault();
      setWaveOn(!state.waveOn);
    } else if (event.key === "v" || event.key === "V") {
      event.preventDefault();
      cycleMode();
    } else if (event.key === "t" || event.key === "T") {
      event.preventDefault();
      toggleTray();
    }
  }

  function watchPlaybar() {
    injectButton();
    playbarObserver = new MutationObserver(guard(injectButton));
    playbarObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function injectButton() {
    const actions = document.querySelector(".playbackSoundBadge__actions");
    if (!actions || actions.querySelector(`.${PLAYBAR_BTN_CLASS}`)) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `${PLAYBAR_BTN_CLASS} sc-button sc-button-secondary sc-button-small sc-button-icon`;
    btn.title = "Visualizer";
    btn.setAttribute("aria-label", "Toggle visualizer");
    btn.appendChild(vizIcon(16));
    btn.addEventListener(
      "click",
      guard((event) => {
        event.preventDefault();
        event.stopPropagation();
        toggle();
      })
    );
    const queue = actions.querySelector(".playbackSoundBadge__showQueue");
    if (queue) actions.insertBefore(btn, queue);
    else actions.appendChild(btn);
    syncButton();
  }

  function syncButton() {
    document.querySelectorAll(`.${PLAYBAR_BTN_CLASS}`).forEach((btn) => {
      btn.classList.toggle("is-on", state.on);
      btn.title = state.on ? "Exit visualizer" : "Visualizer";
    });
  }

  function watchTrack() {
    const tick = () => {
      if (readTrack()) {
        paintMeta();
        if (state.on) {
          extractLocalWaveform();
          refreshTrackData();
          extractAccent(state.track.artwork);
        }
      }
    };
    guard(tick)();
    trackTimer = setInterval(guard(tick), 500);
    const badge = document.querySelector(".playbackSoundBadge");
    if (badge) {
      trackObserver = new MutationObserver(guard(tick));
      trackObserver.observe(badge, {
        childList: true,
        subtree: true,
        attributes: true,
      });
    }
  }

  function readTrack() {
    if (!alive()) return false;
    let titleLink;
    let artistLink;
    let art;
    try {
      titleLink = document.querySelector(".playbackSoundBadge__titleLink");
      artistLink = document.querySelector(".playbackSoundBadge__lightLink");
      art = document.querySelector(".playbackSoundBadge__avatar .image__full");
    } catch (err) {
      if (isInvalidated(err)) {
        shutdown();
        return false;
      }
      throw err;
    }
    const title = (
      titleLink?.getAttribute("title") ||
      titleLink?.textContent ||
      ""
    ).trim();
    const artist = (artistLink?.getAttribute("title") || artistLink?.textContent || "").trim();
    const rawUrl = titleLink?.href || "";
    const url = canonicalTrackUrl(rawUrl) || state.track.url || rawUrl;
    const artwork = upgradeArt(bgUrl(art));
    const key = `${url}|${title}`;
    if (!title || key === state.trackKey) {
      if (url && state.track.url !== url) state.track.url = url;
      return false;
    }
    const switched = Boolean(state.trackKey);
    state.trackKey = key;
    state.track = {
      title,
      artist,
      url,
      artwork,
      duration: readDuration(),
    };
    state.comments = [];
    state.samples = [];
    state.lastToastId = "";
    state.commentStatus = "Loading comments…";
    if (switched) state.trackId = "";
    return true;
  }

  function readDuration() {
    const el = document.querySelector(".playbackTimeline__progressWrapper");
    const max = parseFloat(el?.getAttribute("aria-valuemax") || "0");
    if (max > 100000) return max / 1000;
    return max > 0 ? max : 1;
  }

  function readProgress() {
    const el = document.querySelector(".playbackTimeline__progressWrapper");
    if (!el) return 0;
    const now = parseFloat(el.getAttribute("aria-valuenow") || "0");
    const max = parseFloat(el.getAttribute("aria-valuemax") || "0");
    if (!max) return 0;
    return Math.min(1, Math.max(0, now / max));
  }

  function bgUrl(el) {
    const bg = el?.style?.backgroundImage || "";
    const match = bg.match(/url\((['"]?)(.*?)\1\)/);
    return match ? match[2] : "";
  }

  function upgradeArt(url) {
    if (!url) return "";
    return url.replace(/-t\d+x\d+\./, "-t500x500.");
  }

  function toggle() {
    if (!alive()) return;
    setOn(!state.on);
  }

  async function setOn(on) {
    if (!alive()) return;
    const transitionEpoch = ++state.transitionEpoch;
    clearTimeout(state.transitionTimer);
    state.on = on;
    syncButton();
    if (!on) {
      cancelAnimationFrame(state.raf);
      setPageAudioActive(false);
      teardownCapture();
      clearTimeout(chromeTimer);
      if (!root || !document.documentElement.classList.contains("scviz-on")) {
        state.viz?.stop();
        document.documentElement.classList.remove("scviz-on");
        applyCommentMode();
        return;
      }
      root.classList.remove("scviz-entering", "scviz-chrome-idle");
      root.classList.add("scviz-exiting");
      state.transitionTimer = window.setTimeout(() => {
        if (state.on || state.transitionEpoch !== transitionEpoch) return;
        state.viz?.stop();
        root?.classList.remove("scviz-exiting");
        document.documentElement.classList.remove("scviz-on");
        applyCommentMode();
      }, EXIT_TRANSITION_MS);
      return;
    }
    document.documentElement.classList.add("scviz-on");
    setPageAudioActive(true);
    readTrack();
    try {
      ensureOverlay();
    } catch (err) {
      console.error("Soundstage overlay failed", err);
      state.on = false;
      setPageAudioActive(false);
      document.documentElement.classList.remove("scviz-on");
      syncButton();
      return;
    }
    root.classList.remove("scviz-entering", "scviz-exiting", "scviz-chrome-idle");
    void root.offsetWidth;
    root.classList.add("scviz-entering");
    state.transitionTimer = window.setTimeout(() => {
      if (!state.on || state.transitionEpoch !== transitionEpoch) return;
      root?.classList.remove("scviz-entering");
    }, ENTER_TRANSITION_MS);
    paintMeta();
    state.mode = state.viz.setMode(state.mode);
    state.viz.resize();
    state.viz.start();
    applyCommentMode();
    applyWaveMode();
    syncDisc();
    extractLocalWaveform();
    refreshTrackData();
    extractAccent(state.track.artwork);
    startProgressLoop();
    flashHint();
    wakeChrome();
    window.setTimeout(() => {
      if (state.on && performance.now() - state.tapAliveAt > 500) maybeStartCapture();
    }, 320);
  }

  function setPageAudioActive(active) {
    window.postMessage({ source: "scviz-control", type: "audio-active", active }, "*");
  }

  function flashHint() {
    const hint = root?.querySelector(".scviz-hint");
    if (!hint) return;
    hint.classList.remove("is-gone");
    void hint.offsetWidth;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.add("is-gone"), 3500);
  }

  function wakeChrome() {
    if (!root || !state.on) return;
    root.classList.remove("scviz-chrome-idle");
    clearTimeout(chromeTimer);
    if (!state.waveOn) {
      chromeTimer = setTimeout(tryHideChrome, 3800);
    }
  }

  function tryHideChrome() {
    if (!state.on || state.waveOn || !root) return;
    if (root.querySelector(".scviz-tray.is-open, .scviz-tray.is-hold, .scviz-hud-actions:hover, #scviz-knobs:hover")) {
      chromeTimer = setTimeout(tryHideChrome, 2000);
      return;
    }
    root.classList.add("scviz-chrome-idle");
  }

  function startProgressLoop() {
    cancelAnimationFrame(state.raf);
    const loop = () => {
      if (!state.on || !alive()) return;
      try {
        const progress = readProgress();
        state.viz?.setProgress(progress);
        maybeToast(progress);
        highlightRail(progress);
        state.raf = requestAnimationFrame(loop);
      } catch (err) {
        if (isInvalidated(err)) shutdown();
      }
    };
    state.raf = requestAnimationFrame(loop);
  }

  function ensureOverlay() {
    if (root) return;
    root = h("div", { id: "scviz-root" }, [
      h("div", { class: "scviz-stage" }, [
        h("div", { class: "scviz-art-bg" }),
        h("div", { class: "scviz-vignette" }),
        h("canvas", { id: "scviz-canvas" }),
        h("div", { class: "scviz-hud" }, [
          h("button", { type: "button", class: "scviz-chip", id: "scviz-knobs" }),
          h("div", { class: "scviz-hud-actions" }, [
            h("button", { type: "button", class: "scviz-chip", id: "scviz-mode" }),
            h("button", { type: "button", class: "scviz-chip", id: "scviz-comments" }),
            h("button", { type: "button", class: "scviz-chip", id: "scviz-wave" }),
            h("button", { type: "button", class: "scviz-chip", id: "scviz-close" }, [
              closeIcon(),
              " Exit",
            ]),
          ]),
        ]),
        h("div", { class: "scviz-hint", text: "Esc exit · V visualizer · T knobs · C comments · W waveform" }),
        h("div", { class: "scviz-tray" }, [
          h("div", { class: "scviz-tray-panel" }, [
            paramSlider("sensitivity", "Sensitivity", 0, 2.2, 0.05, "all"),
            paramSlider("loudGlow", "Loud glow", 0, 2, 0.05, "all"),
            paramToggle("pulseArt", "Cover art", "pulse"),
            paramSlider("bloomBright", "Bright", 0.58, 0.85, 0.01, "bloom"),
            paramSlider("bloomSize", "Size", 0.4, 2.2, 0.05, "bloom"),
            paramSlider("bloomSpread", "Spread", 0, 1.6, 0.05, "bloom"),
            paramSlider("bloomSpin", "Spin", 0, 2.5, 0.05, "bloom"),
            paramSlider("bloomShape", "Shape", 0, 1, 0.01, "bloom"),
            paramSlider("bloomHue", "Hue", 0, 1, 0.01, "bloom"),
            paramSlider("bloomWarm", "Warm", 0, 1, 0.01, "bloom"),
            paramSlider("bloomSpark", "Spark", 0, 1, 0.01, "bloom"),
            paramSlider("bloomSoft", "Soft", 0, 1, 0.01, "bloom"),
            paramSlider("bloomTight", "Tight", 0, 1, 0.01, "bloom"),
            paramSlider("ridgeZoom", "Zoom", 2.2, 3.5, 0.05, "ridge"),
            paramSlider("ridgeHeight", "Height", 0.7, 4.5, 0.05, "ridge"),
            paramSlider("ridgeFreq", "Freq", 0.2, 1, 0.01, "ridge"),
            paramSlider("ridgeFuzz", "Fuzz", 0, 1, 0.01, "ridge"),
            paramSlider("magReflect", "Reflect", 0, 1, 0.01, "magnetosphere"),
            paramSlider("magVoidGlow", "Void halo", 0, 1, 0.01, "magnetosphere"),
            paramSlider("magDensity", "Density", 0.1, 1, 0.01, "magnetosphere"),
            paramSlider("magDensityAuto", "Density flow", 0, 1, 0.01, "magnetosphere"),
            paramSlider("magTrail", "Trails", 0.2, 2.5, 0.05, "magnetosphere"),
            paramSlider("magRibbon", "Ribbons", 0, 2.5, 0.05, "magnetosphere"),
            paramSlider("magAtmosphere", "Atmosphere", 0, 2, 0.05, "magnetosphere"),
            paramSlider("magBloom", "Bloom", 0.2, 1.1, 0.05, "magnetosphere"),
            paramSlider("magMotion", "Motion", 0.25, 2, 0.05, "magnetosphere"),
            paramSlider("magCoreSize", "Core size", 0.6, 1.6, 0.05, "magnetosphere"),
          ]),
        ]),
        h("div", { class: "scviz-center" }, [
          h("div", { class: "scviz-disc is-hidden" }),
          h("div", { class: "scviz-meta" }, [
            h("div", { class: "scviz-title" }),
            h("div", { class: "scviz-artist" }),
          ]),
        ]),
        h("div", { class: "scviz-rail", hidden: true }),
        h("div", { class: "scviz-toasts" }),
      ]),
      h("div", { class: "scviz-wave" }, [
        h("canvas", { id: "scviz-wave-canvas" }),
        h("div", { class: "scviz-dots" }),
      ]),
    ]);
    document.documentElement.appendChild(root);

    canvas = root.querySelector("#scviz-canvas");
    waveCanvas = root.querySelector("#scviz-wave-canvas");
    artBg = root.querySelector(".scviz-art-bg");
    artDisc = root.querySelector(".scviz-disc");
    titleEl = root.querySelector(".scviz-title");
    artistEl = root.querySelector(".scviz-artist");
    commentsBtn = root.querySelector("#scviz-comments");
    waveBtn = root.querySelector("#scviz-wave");
    knobsBtn = root.querySelector("#scviz-knobs");
    modeBtn = root.querySelector("#scviz-mode");
    dotsEl = root.querySelector(".scviz-dots");
    toastsEl = root.querySelector(".scviz-toasts");
    railEl = root.querySelector(".scviz-rail");

    state.viz = new SCVizVisualizer(canvas, waveCanvas);
    state.viz.setDisc(artDisc);
    state.viz.setParams(state.params);
    state.mode = state.viz.setMode(state.mode);
    window.addEventListener("resize", () => state.viz?.resize());

    commentsBtn.addEventListener("click", guard(() => setCommentsOn(!state.commentsOn)));
    waveBtn.addEventListener("click", guard(() => setWaveOn(!state.waveOn)));
    knobsBtn.addEventListener("click", guard(() => toggleTray()));
    modeBtn.addEventListener("click", guard(() => cycleMode()));
    root.querySelector("#scviz-close").addEventListener("click", guard(() => setOn(false)));
    root.querySelector(".scviz-wave").addEventListener("click", guard(onWaveClick));
    root.addEventListener("mousemove", guard(wakeChrome));
    bindTrayHold();
    syncModeButton();
    syncKnobsButton();
    applyCommentMode();
    applyWaveMode();
  }

  function cycleMode() {
    if (!alive() || !state.viz) return;
    const next = state.viz.cycleMode();
    state.mode = next;
    try {
      chrome.storage.local.set({ mode: next });
    } catch (err) {
      if (isInvalidated(err)) shutdown();
    }
    syncModeButton();
    syncDisc();
  }

  function syncModeButton() {
    if (!modeBtn) return;
    const current = MODES().find((m) => m.id === state.mode) || MODES()[0];
    setChip(modeBtn, vizIcon(14), current.label);
    modeBtn.title = "Cycle visualizer (V)";
    lockModeChipWidth();
  }

  function lockModeChipWidth() {
    if (!modeBtn || modeBtn.dataset.widthLocked) return;
    const probe = document.createElement("button");
    probe.className = "scviz-chip";
    probe.style.cssText =
      'position:fixed;left:-9999px;top:0;visibility:hidden;width:auto;min-width:0;font:600 13px Interstate,"Lucida Grande","Lucida Sans Unicode","Lucida Sans",Garuda,Verdana,Tahoma,sans-serif;letter-spacing:0.01em';
    document.documentElement.appendChild(probe);
    let max = 0;
    for (const mode of MODES()) {
      setChip(probe, vizIcon(14), mode.label);
      max = Math.max(max, probe.offsetWidth);
    }
    probe.remove();
    if (max > 0) {
      modeBtn.style.minWidth = `${Math.ceil(max)}px`;
      modeBtn.dataset.widthLocked = "1";
    }
  }

  function toggleTray() {
    const tray = root?.querySelector(".scviz-tray");
    if (!tray) return;
    tray.classList.toggle("is-open");
    syncKnobsButton();
    wakeChrome();
  }

  function syncKnobsButton() {
    if (!knobsBtn) return;
    const open = Boolean(root?.querySelector(".scviz-tray.is-open"));
    knobsBtn.classList.toggle("is-on", open);
    setChip(knobsBtn, knobsIcon(), open ? "Knobs on" : "Knobs");
    knobsBtn.title = "Show knobs (T)";
  }

  function bindTrayHold() {
    const tray = root?.querySelector(".scviz-tray");
    if (!tray) return;
    const hold = (on) => tray.classList.toggle("is-hold", on);
    tray.addEventListener(
      "pointerdown",
      guard((event) => {
        if (event.target?.closest?.("input")) hold(true);
      })
    );
    window.addEventListener(
      "pointerup",
      guard(() => hold(false))
    );
    window.addEventListener(
      "pointercancel",
      guard(() => hold(false))
    );
  }

  function paramSlider(key, label, min, max, step, group) {
    const input = h("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(state.params[key]),
    });
    input.dataset.param = key;
    const read = h("em", { class: "scviz-tray-val", text: formatParam(state.params[key]) });
    input.addEventListener(
      "input",
      guard(() => {
        const v = Number(input.value);
        state.params[key] = v;
        state.params = clampParams(state.params);
        read.textContent = formatParam(state.params[key]);
        state.viz?.setParams({ [key]: state.params[key] });
        persistParams();
      })
    );
    return h("label", { class: "scviz-tray-item", "data-for": group || "all" }, [
      h("span", { text: label }),
      input,
      read,
    ]);
  }

  function paramToggle(key, label, group) {
    const on = Number(state.params[key]) >= 0.5;
    const input = h("input", { type: "checkbox" });
    input.dataset.param = key;
    input.checked = on;
    const read = h("em", { class: "scviz-tray-val", text: on ? "On" : "Off" });
    input.addEventListener(
      "change",
      guard(() => {
        const v = input.checked ? 1 : 0;
        state.params[key] = v;
        state.params = clampParams(state.params);
        read.textContent = state.params[key] >= 0.5 ? "On" : "Off";
        state.viz?.setParams({ [key]: state.params[key] });
        persistParams();
      })
    );
    return h("label", { class: "scviz-tray-item scviz-tray-toggle", "data-for": group || "all" }, [
      h("span", { text: label }),
      input,
      read,
    ]);
  }

  function formatParam(v) {
    const n = Number(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  }

  const PARAM_LIMITS = {
    bloomBright: [0.58, 0.85, 0.72],
    bloomSize: [0.4, 2.2, 1],
    bloomSpread: [0, 1.6, 0.55],
    bloomSpin: [0, 2.5, 1],
    bloomShape: [0, 1, 0.28],
    bloomHue: [0, 1, 0.72],
    bloomWarm: [0, 1, 0.42],
    bloomSpark: [0, 1, 0.48],
    bloomSoft: [0, 1, 0.55],
    bloomTight: [0, 1, 0],
    ridgeZoom: [2.2, 3.5, 2.4],
    ridgeHeight: [0.7, 4.5, 1.15],
    ridgeFreq: [0.2, 1, 1],
    ridgeFuzz: [0, 1, 0.28],
    pulseArt: [0, 1, 1],
    sensitivity: [0, 2.2, 1],
    loudGlow: [0, 2, 0.85],
    magReflect: [0, 1, 0.52],
    magVoidGlow: [0, 1, 0.12],
    magDensity: [0.1, 1, 0.88],
    magDensityAuto: [0, 1, 0.58],
    magTrail: [0.2, 2.5, 1],
    magRibbon: [0, 2.5, 1],
    magAtmosphere: [0, 2, 1],
    magBloom: [0.2, 1.1, 1],
    magMotion: [0.25, 2, 1],
    magCoreSize: [0.6, 1.6, 1],
  };

  function clampParams(params) {
    const out = { ...params };
    for (const [key, range] of Object.entries(PARAM_LIMITS)) {
      const lo = range[0];
      const hi = range[1];
      const fallback = range[2];
      const v = Number(out[key]);
      out[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
    }
    return out;
  }

  function persistParams() {
    try {
      chrome.storage.local.set({ params: state.params });
    } catch (err) {
      if (isInvalidated(err)) shutdown();
    }
  }

  function syncTray() {
    if (!root) return;
    root.querySelectorAll(".scviz-tray-item input[data-param]").forEach((input) => {
      const key = input.dataset.param;
      if (!(key in state.params)) return;
      const read = input.parentElement?.querySelector(".scviz-tray-val");
      if (input.type === "checkbox") {
        input.checked = Number(state.params[key]) >= 0.5;
        if (read) read.textContent = input.checked ? "On" : "Off";
        return;
      }
      input.value = String(state.params[key]);
      if (read) read.textContent = formatParam(state.params[key]);
    });
  }

  function syncDisc() {
    if (!artDisc) return;
    artDisc.classList.add("is-hidden");
    if (!root) return;
    root.classList.remove(
      "scviz-mode-pulse",
      "scviz-mode-ridge",
      "scviz-mode-bloom",
      "scviz-mode-magnetosphere"
    );
    root.classList.add(`scviz-mode-${state.mode}`);
  }

  function paintMeta() {
    if (!root) return;
    titleEl.textContent = state.track.title || "SoundCloud";
    artistEl.textContent = state.track.artist || "";
    const art = state.track.artwork;
    artBg.style.backgroundImage = art ? `url("${art}")` : "none";
    artDisc.style.backgroundImage = art ? `url("${art}")` : "none";
    state.viz?.setArtwork(art);
    applyCommentMode();
    renderDots();
    renderRail();
  }

  function setCommentsOn(on) {
    if (!alive()) return;
    state.commentsOn = on;
    try {
      chrome.storage.local.set({ commentsOn: on });
    } catch (err) {
      if (isInvalidated(err)) {
        shutdown();
        return;
      }
    }
    applyCommentMode();
    if (on) {
      renderDots();
      renderRail();
      if (!state.comments.length) refreshTrackData();
    }
  }

  function setWaveOn(on) {
    if (!alive()) return;
    state.waveOn = on;
    try {
      chrome.storage.local.set({ waveOn: on });
    } catch (err) {
      if (isInvalidated(err)) {
        shutdown();
        return;
      }
    }
    applyWaveMode();
  }

  function applyWaveMode() {
    document.documentElement.classList.toggle("scviz-wave-off", !state.waveOn);
    waveBtn?.classList.toggle("is-on", state.waveOn);
    if (waveBtn) {
      setChip(waveBtn, waveIcon(), state.waveOn ? "Waveform" : "Waveform off");
    }
    if (state.on && state.waveOn) {
      requestAnimationFrame(() => {
        if (state.on && state.waveOn) state.viz?.resize();
      });
    }
    wakeChrome();
  }

  function applyCommentMode() {
    document.documentElement.classList.toggle("scviz-comments-off", !state.commentsOn);
    commentsBtn?.classList.toggle("is-on", state.commentsOn);
    if (commentsBtn) {
      const count = state.comments.length;
      const label = !state.commentsOn
        ? "Comments off"
        : count
          ? `Comments · ${count}`
          : "Comments on";
      setChip(commentsBtn, commentIcon(), label);
    }
    if (railEl) railEl.hidden = !state.commentsOn;
    hideNativeComments(state.on && !state.commentsOn);
  }

  function hideNativeComments(hide) {
    document.documentElement.classList.toggle("scviz-hide-sc-comments", hide);
    const docs = collectDocs();
    for (const doc of docs) {
      let style = doc.getElementById("scviz-hide-comments");
      if (!hide) {
        style?.remove();
        continue;
      }
      if (!style) {
        style = doc.createElement("style");
        style.id = "scviz-hide-comments";
        doc.documentElement.appendChild(style);
      }
      style.textContent = `
        [aria-label="Comments"],
        [aria-label="Comments (preview)"],
        [aria-label="Comment time selector"],
        [aria-label*="commented at"],
        canvas.waveformCommentsNode,
        .commentPopover,
        .commentPlaceholder {
          visibility: hidden !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `;
    }
  }

  function collectDocs() {
    const docs = [document];
    document.querySelectorAll("iframe.webiIframe, iframe.webiIframeV2Layout").forEach((frame) => {
      try {
        if (frame.contentDocument) docs.push(frame.contentDocument);
      } catch {
        // cross-origin, skip
      }
    });
    return docs;
  }

  function queryAllDocs(selector) {
    const nodes = [];
    for (const doc of collectDocs()) {
      try {
        nodes.push(...doc.querySelectorAll(selector));
      } catch {
        // ignore
      }
    }
    return nodes;
  }

  function extractLocalWaveform() {
    const slider = queryAllDocs('[aria-label="Waveform"]')[0];
    const svg = slider?.querySelector("svg");
    if (!svg) return;
    const rects = [...svg.querySelectorAll("rect")];
    if (rects.length < 8) return;
    const samples = [];
    for (let i = 0; i < rects.length; i += 2) {
      samples.push(parseFloat(rects[i].getAttribute("height")) || 0);
    }
    if (samples.length) {
      state.samples = samples;
      state.viz.setWaveform(samples);
    }
  }

  async function refreshTrackData() {
    const url = canonicalTrackUrl(state.track.url) || canonicalTrackUrl(location.href);
    const clientId = state.clientId || (await waitForClientId());
    let trackId = state.trackId;
    if (!trackId && url && clientId) {
      try {
        const resolved = await fetchJson(
          `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`
        );
        if (resolved?.id) trackId = String(resolved.id);
        if (resolved?.duration) state.track.duration = resolved.duration / 1000;
        if (resolved?.permalink_url) state.track.url = resolved.permalink_url;
        if (resolved?.artwork_url && !state.track.artwork) {
          state.track.artwork = upgradeArt(resolved.artwork_url);
          paintMeta();
        }
        if (resolved?.waveform_url) await loadWaveform(resolved.waveform_url);
      } catch {
        // fall through to DOM comments
      }
    }
    if (trackId && clientId) {
      state.trackId = trackId;
      try {
        await loadComments(trackId, clientId);
        return;
      } catch {
        // fall through
      }
    }
    scrapeCommentsFromDom();
    if (!state.comments.length) {
      state.commentStatus = "No comments found for this track";
      renderRail();
    }
  }

  async function loadWaveform(waveformUrl) {
    if (state.samples.length) return;
    try {
      const jsonUrl = waveformUrl.replace(/\.png.*/, ".json");
      const data = await fetchJson(jsonUrl);
      const samples = data?.samples || data;
      if (Array.isArray(samples) && samples.length) {
        state.samples = samples;
        state.viz.setWaveform(samples);
      }
    } catch {
      // keep whatever we extracted from the page
    }
  }

  async function loadComments(trackId, clientId) {
    const comments = [];
    let href = `https://api-v2.soundcloud.com/tracks/${trackId}/comments?threaded=0&limit=200&client_id=${encodeURIComponent(clientId)}`;
    for (let page = 0; page < 4 && href; page++) {
      const data = await fetchJson(href);
      const batch = data?.collection || [];
      for (const item of batch) {
        const mapped = mapApiComment(item);
        if (mapped) comments.push(mapped);
      }
      href = nextHref(data?.next_href, clientId);
    }
    comments.sort((a, b) => a.t - b.t);
    if (comments.length) {
      mergeComments(comments);
    } else {
      scrapeCommentsFromDom();
    }
  }

  function mapApiComment(item) {
    const timestamp = Number(item.timestamp);
    const t = Number.isFinite(timestamp) ? timestamp / 1000 : 0;
    const body = String(item.body || "").trim();
    if (!body) return null;
    return {
      id: String(item.id || `${item.user?.id}-${t}-${body}`),
      t,
      body,
      user: item.user?.username || "User",
      avatar: item.user?.avatar_url || "",
    };
  }

  function nextHref(href, clientId) {
    if (!href) return "";
    if (href.includes("client_id=")) return href;
    return `${href}${href.includes("?") ? "&" : "?"}client_id=${encodeURIComponent(clientId)}`;
  }

  function scrapeCommentsFromDom() {
    const found = [];
    for (const el of queryAllDocs('[aria-label*="commented at"]')) {
      const label = el.getAttribute("aria-label") || "";
      const parsed = parseCommentLabel(label);
      if (!parsed) continue;
      const body =
        el.parentElement?.parentElement?.querySelector("p")?.textContent?.trim() || "";
      const avatar =
        el.closest(".MuiStack-root")?.parentElement?.querySelector("img")?.src || "";
      found.push({
        id: label,
        t: parsed.seconds,
        body,
        user: parsed.user,
        avatar,
      });
    }
    if (found.length) mergeComments(found);
  }

  function parseCommentLabel(label) {
    const match = label.match(/^(.*?) commented at (.*?),/);
    if (!match) return null;
    const seconds = parseSpokenTime(match[2]);
    if (seconds == null) return null;
    return { user: match[1], seconds };
  }

  function parseSpokenTime(text) {
    if (!text) return null;
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    const h = text.match(/(\d+)\s*hour/);
    const m = text.match(/(\d+)\s*minute/);
    const s = text.match(/(\d+)\s*second/);
    if (h) hours = +h[1];
    if (m) minutes = +m[1];
    if (s) seconds = +s[1];
    if (!h && !m && !s) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  function mergeComments(incoming) {
    if (!incoming?.length) return;
    const map = new Map(state.comments.map((c) => [c.id, c]));
    for (const item of incoming) {
      if (!item?.id) continue;
      map.set(item.id, item);
    }
    state.comments = [...map.values()].sort((a, b) => a.t - b.t);
    state.commentStatus = "";
    renderDots();
    renderRail();
    applyCommentMode();
  }

  function renderDots() {
    if (!dotsEl) return;
    dotsEl.replaceChildren();
    if (!state.commentsOn) return;
    const duration = state.track.duration || 1;
    const max = Math.min(state.comments.length, 90);
    const step = Math.max(1, Math.ceil(state.comments.length / max));
    for (let i = 0; i < state.comments.length; i += step) {
      const comment = state.comments[i];
      const left = (comment.t / duration) * 100;
      if (left < 0 || left > 100) continue;
      const dot = document.createElement("div");
      dot.className = "scviz-dot";
      dot.style.left = `${left}%`;
      dot.title = `${comment.user}: ${comment.body}`;
      if (comment.avatar) {
        const img = document.createElement("img");
        img.src = comment.avatar;
        img.alt = "";
        dot.appendChild(img);
      }
      dotsEl.appendChild(dot);
    }
  }

  function renderRail() {
    if (!railEl) return;
    if (!state.commentsOn) {
      railEl.hidden = true;
      return;
    }
    railEl.hidden = false;
    if (!state.comments.length) {
      railEl.replaceChildren(
        h("div", { class: "scviz-rail-empty", text: state.commentStatus || "Loading comments…" })
      );
      return;
    }
    const items = state.comments.slice(0, 80).map((comment) => {
      const btn = h("button", { type: "button", class: "scviz-rail-item" }, [
        comment.avatar
          ? h("img", { src: comment.avatar, alt: "" })
          : h("span", { class: "scviz-rail-fallback" }),
        h("span", {}, [
          h("b", {}, [comment.user + " ", h("em", { text: formatTime(comment.t) })]),
          h("i", { text: comment.body }),
        ]),
      ]);
      btn.dataset.id = comment.id;
      btn.dataset.t = String(comment.t);
      btn.addEventListener("click", () => {
        const duration = state.track.duration || 1;
        seekTo(comment.t / duration);
      });
      return btn;
    });
    railEl.replaceChildren(...items);
  }

  function highlightRail(progress) {
    if (!railEl || !state.commentsOn || !state.comments.length) return;
    const t = progress * (state.track.duration || 1);
    let current = null;
    for (const comment of state.comments) {
      if (comment.t <= t + 0.25) current = comment;
      else break;
    }
    railEl.querySelectorAll(".scviz-rail-item").forEach((el) => {
      const on = current && el.dataset.id === current.id;
      el.classList.toggle("is-current", on);
    });
  }

  function maybeToast(progress) {
    if (!state.commentsOn || !state.comments.length || !toastsEl) return;
    const t = progress * (state.track.duration || 1);
    let hit = null;
    for (const comment of state.comments) {
      if (comment.t <= t + 0.2) hit = comment;
      else break;
    }
    if (!hit || hit.id === state.lastToastId) return;
    if (t - hit.t > 10) return;
    const now = Date.now();
    if (now - state.lastToastAt < 900) return;
    state.lastToastAt = now;
    state.lastToastId = hit.id;
    spawnToast(hit, progress);
  }

  function spawnToast(comment, progress) {
    const toast = document.createElement("div");
    toast.className = "scviz-toast";
    toast.style.left = `${8 + progress * 84}%`;
    if (comment.avatar) toast.appendChild(h("img", { src: comment.avatar, alt: "" }));
    toast.appendChild(
      h("div", {}, [
        h("b", { text: comment.user }),
        h("span", { text: comment.body || "" }),
      ])
    );
    toastsEl.appendChild(toast);
    window.setTimeout(() => toast.remove(), 4300);
    while (toastsEl.children.length > 4) toastsEl.firstChild.remove();
  }

  function onWaveClick(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - rect.left) / Math.max(1, rect.width);
    seekTo(ratio);
  }

  function seekTo(ratio) {
    const clamped = Math.min(0.999, Math.max(0, Number(ratio) || 0));
    let did = false;
    for (const doc of collectDocs()) {
      for (const media of doc.querySelectorAll("audio, video")) {
        const duration = media.duration;
        if (!Number.isFinite(duration) || duration <= 0) continue;
        try {
          media.currentTime = clamped * duration;
          did = true;
        } catch {
          // ignore unseekable streams
        }
      }
    }
    const slider = queryAllDocs('[aria-label="Waveform"]')[0];
    if (slider) {
      fireSeek(slider, clamped);
      did = true;
    }
    const bar =
      document.querySelector(".playbackTimeline__progressBackground") ||
      document.querySelector(".playbackTimeline__progressWrapper");
    if (bar) fireSeek(bar, clamped);
    return did;
  }

  function fireSeek(el, ratio) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2) return;
    const x = rect.left + rect.width * ratio;
    const y = rect.top + Math.max(2, rect.height / 2);
    const view = el.ownerDocument.defaultView || window;
    const offsetX = rect.width * ratio;
    const offsetY = Math.max(2, rect.height / 2);
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view,
      clientX: x,
      clientY: y,
      pageX: x + view.scrollX,
      pageY: y + view.scrollY,
      screenX: x,
      screenY: y,
      button: 0,
      buttons: 1,
    };
    const decorate = (ev) => {
      try {
        Object.defineProperties(ev, {
          offsetX: { get: () => offsetX },
          offsetY: { get: () => offsetY },
        });
      } catch {
        // some browsers freeze these
      }
      return ev;
    };
    el.dispatchEvent(
      decorate(
        new PointerEvent("pointerdown", {
          ...base,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        })
      )
    );
    el.dispatchEvent(decorate(new MouseEvent("mousedown", base)));
    el.dispatchEvent(
      decorate(
        new PointerEvent("pointerup", {
          ...base,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          buttons: 0,
        })
      )
    );
    el.dispatchEvent(decorate(new MouseEvent("mouseup", { ...base, buttons: 0 })));
    el.dispatchEvent(decorate(new MouseEvent("click", { ...base, buttons: 0 })));
  }

  async function maybeStartCapture() {
    if (!state.on || state.captureTried || !alive()) return;
    if (performance.now() - state.tapAliveAt <= 500) return;
    state.captureTried = true;
    try {
      await startTabCapture();
    } catch (err) {
      if (isInvalidated(err)) shutdown();
      else if (!isBenignCaptureError(err)) console.warn("Soundstage: tab capture failed", err);
    }
  }

  async function startTabCapture() {
    const response = await chrome.runtime.sendMessage({ type: "scviz-stream-id" });
    if (!response?.id) throw new Error(response?.error || "no stream id");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: response.id,
        },
      },
    });
    const ctx = new AudioContext();
    if (ctx.state === "suspended") await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.38;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -22;
    source.connect(analyser);
    source.connect(ctx.destination);
    const freq = new Uint8Array(analyser.frequencyBinCount);
    const time = new Uint8Array(analyser.fftSize);
    const outF = new Uint8Array(256);
    const outT = new Uint8Array(512);

    const tick = () => {
      if (!state.capture || !alive()) return;
      try {
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(time);
        logBucket(freq, outF, analyser);
        pick(time, outT);
        state.viz.setAudio(outF, outT);
        state.capture.raf = requestAnimationFrame(tick);
      } catch (err) {
        if (isInvalidated(err)) shutdown();
      }
    };

    state.capture = { stream, ctx, raf: requestAnimationFrame(tick) };
  }

  function teardownCapture() {
    state.captureTried = false;
    const cap = state.capture;
    state.capture = null;
    if (!cap) return;
    cancelAnimationFrame(cap.raf);
    cap.stream?.getTracks().forEach((track) => track.stop());
    cap.ctx?.close().catch(() => {});
  }

  function pick(src, dest) {
    const step = src.length / dest.length;
    for (let i = 0; i < dest.length; i++) dest[i] = src[(i * step) | 0];
  }

  function logBucket(src, dest, analyser) {
    const n = dest.length;
    const N = src.length;
    const sr = analyser?.context?.sampleRate || 44100;
    const fftSize = analyser?.fftSize || N * 2;
    const binHz = sr / fftSize;
    const minIdx = Math.max(1, Math.round(38 / binHz));
    const maxIdx = Math.min(N - 1, Math.round(15500 / binHz));
    const span = Math.max(2, maxIdx / minIdx);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(
        minIdx,
        Math.floor(minIdx * Math.pow(span, i / n))
      );
      const hi = Math.max(
        lo + 1,
        Math.floor(minIdx * Math.pow(span, (i + 1) / n))
      );
      let peak = 0;
      let sum = 0;
      let count = 0;
      for (let j = lo; j < hi && j < N; j++) {
        const v = src[j];
        sum += v;
        count++;
        if (v > peak) peak = v;
      }
      dest[i] = count ? 0.4 * (sum / count) + 0.6 * peak : 0;
    }
  }

  function waitForClientId() {
    return new Promise((resolve) => {
      if (state.clientId) return resolve(state.clientId);
      let tries = 0;
      const id = setInterval(() => {
        tries += 1;
        if (state.clientId || tries > 24) {
          clearInterval(id);
          resolve(state.clientId);
        }
      }, 150);
    });
  }

  async function fetchJson(url) {
    if (!alive()) throw new Error("extension context invalidated");
    const headers = {};
    if (state.oauth) {
      headers.Authorization = /^(OAuth|Bearer)\s/i.test(state.oauth)
        ? state.oauth
        : `OAuth ${state.oauth}`;
    }
    const res = await chrome.runtime.sendMessage({ type: "scviz-fetch", url, headers });
    if (!res?.ok) throw new Error(res?.error || "fetch failed");
    return res.data;
  }

  function canonicalTrackUrl(url) {
    try {
      const parsed = new URL(url, location.origin);
      parsed.search = "";
      parsed.hash = "";
      const path = parsed.pathname.replace(/^\/n\//, "/");
      parsed.pathname = path;
      const parts = path.split("/").filter(Boolean);
      if (parts[0] === "undefined") return "";
      const reserved = new Set([
        "you",
        "stream",
        "discover",
        "search",
        "pages",
        "settings",
        "messages",
        "notifications",
        "upload",
        "charts",
        "feed",
        "n",
      ]);
      if (
        parsed.hostname.endsWith("soundcloud.com") &&
        parts.length >= 2 &&
        !reserved.has(parts[0])
      ) {
        return `https://soundcloud.com/${parts[0]}/${parts[1]}`;
      }
    } catch {
      // ignore
    }
    return "";
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function punchColor(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 18 / 360;
    let s = max === 0 ? 0 : d / max;
    let l = (max + min) / 2;
    if (d > 0.001) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    if (s < 0.22) {
      h = 18 / 360;
      s = 0.82;
      l = Math.max(0.52, l);
    } else {
      s = Math.min(1, Math.max(0.62, s * 1.35));
      l = Math.min(0.62, Math.max(0.48, l));
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    ];
  }

  async function extractAccent(url) {
    if (!url) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = 24;
      c.height = 24;
      const ctx = c.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, 24, 24);
      const data = ctx.getImageData(0, 0, 24, 24).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < data.length; i += 4) {
        const rr = data[i];
        const gg = data[i + 1];
        const bb = data[i + 2];
        const max = Math.max(rr, gg, bb);
        const min = Math.min(rr, gg, bb);
        if (max < 28) continue;
        const sat = max === 0 ? 0 : (max - min) / max;
        const w = 0.35 + sat * 1.8;
        r += rr * w;
        g += gg * w;
        b += bb * w;
        n += w;
      }
      const avg = n ? [r / n, g / n, b / n] : [255, 85, 0];
      state.accent = punchColor(avg[0], avg[1], avg[2]);
      state.viz.setAccent(state.accent);
    } catch {
      // keep SoundCloud orange
    }
  }

  function h(tag, attrs, children) {
    const svg = tag === "svg" || tag === "path" || tag === "rect" || tag === "g";
    const el = svg
      ? document.createElementNS("http://www.w3.org/2000/svg", tag)
      : document.createElement(tag);
    if (attrs) {
      for (const [key, value] of Object.entries(attrs)) {
        if (value == null || value === false) continue;
        if (key === "class") {
          if (svg) el.setAttribute("class", value);
          else el.className = value;
        } else if (key === "text") {
          el.textContent = value;
        } else if (key === "hidden") {
          el.hidden = true;
        } else if (key === "style" && typeof value === "object") {
          Object.assign(el.style, value);
        } else {
          el.setAttribute(key, String(value));
        }
      }
    }
    const list = children == null ? [] : Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child == null || child === false || child === "") continue;
      el.append(child);
    }
    return el;
  }

  function setChip(btn, icon, label) {
    btn.replaceChildren(icon, document.createTextNode(` ${label}`));
  }

  function vizIcon(size) {
    return h("svg", { viewBox: "0 0 16 16", width: String(size), height: String(size), "aria-hidden": "true" }, [
      h("path", {
        fill: "currentColor",
        d: "M1 10h2v6H1V10zm4-5h2v11H5V5zm4-3h2v14H9V2zm4 5h2v9h-2V7z",
      }),
    ]);
  }

  function waveIcon() {
    return h("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, [
      h("path", {
        fill: "none",
        stroke: "currentColor",
        "stroke-width": "1.6",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        d: "M1 8h1.6l1.2-4.5L6.2 13 8 3.5 10 12l1.4-4H15",
      }),
    ]);
  }

  function commentIcon() {
    return h("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, [
      h("path", {
        fill: "currentColor",
        d: "M2 2h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6l-3.2 2.4A.5.5 0 0 1 2 13.8V3a1 1 0 0 1 1-1z",
      }),
    ]);
  }

  function knobsIcon() {
    return h("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, [
      h("path", {
        fill: "currentColor",
        d: "M3 2h2v3h2v2H5v7H3V7H1V5h2V2zm8 0h2v7h2v2h-2v3h-2v-3H9V9h2V2z",
      }),
    ]);
  }

  function closeIcon() {
    return h("svg", { viewBox: "0 0 16 16", "aria-hidden": "true" }, [
      h("path", {
        fill: "currentColor",
        d: "M3.2 3.2 8 8l4.8-4.8 1.4 1.4L9.4 9.4l4.8 4.8-1.4 1.4L8 10.8l-4.8 4.8-1.4-1.4 4.8-4.8-4.8-4.8 1.4-1.4z",
      }),
    ]);
  }
})();
