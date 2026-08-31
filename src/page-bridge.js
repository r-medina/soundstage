"use strict";

(() => {
  let audioActive = false;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.source === "scviz-control" && data.type === "audio-active") {
      if (data.workletUrl) workletUrl = data.workletUrl;
      audioActive = Boolean(data.active);
      syncEngine();
    }
  });
  const NativeAC = window.AudioContext || window.webkitAudioContext;
  if (NativeAC) wrapAudioContext(NativeAC);

  hookFetch();
  hookXHR();
  reportClientId();
  reportAuth();
  document.addEventListener("DOMContentLoaded", () => {
    reportClientId();
    reportAuth();
  });

  function post(payload) {
    const msg = { source: "scviz", ...payload };
    window.postMessage(msg, "*");
    if (window.top && window.top !== window) {
      try {
        window.top.postMessage(msg, "*");
      } catch {
        // ignore
      }
    }
  }

  function wrapAudioContext(Native) {
    const origCMS = Native.prototype.createMediaElementSource;
    Native.prototype.createMediaElementSource = function (el) {
      const src = origCMS.call(this, el);
      attachAnalyser(this, src);
      return src;
    };

    const origCSS = Native.prototype.createMediaStreamSource;
    Native.prototype.createMediaStreamSource = function (stream) {
      const src = origCSS.call(this, stream);
      attachAnalyser(this, src);
      return src;
    };
  }

  let engine = null;
  let audioCtx = null;
  let audioSource = null;
  let workletUrl = "";
  const frameMsg = { type: "audio-frame" };
  let statusAt = 0;

  function attachAnalyser(ctx, sourceNode) {
    if (audioSource) return;
    audioCtx = ctx;
    audioSource = sourceNode;
    syncEngine();
  }

  /**
   * The engine owns an audio-thread tap, so it is torn down when playing mode
   * is off rather than left running. Restarting is cheap: the worklet module
   * is only fetched once per AudioContext.
   */
  function syncEngine() {
    if (!audioSource) return;
    if (audioActive && !engine) {
      const Audio = window.ScvizAudio;
      if (!Audio) return;
      try {
        engine = new Audio.AudioEngine(audioCtx, audioSource, {
          workletUrl,
          onFrame: emitFrame,
          onStatus: (status) => post({ type: "audio-status", status }),
        });
        engine.start().catch(() => {});
      } catch {
        engine = null;
      }
    } else if (!audioActive && engine) {
      engine.stop();
      engine = null;
      statusAt = 0;
    }
  }

  function emitFrame(f) {
    // Copy every field the engine produces rather than a hand-written list.
    // The list version was written before the onset layer and beat clock
    // existed and was never updated, so none of that reached the page: the
    // visualiser saw levels and a spectrum but no onsets, no tempo and no
    // beat phase, and silently fell back to purely reactive behaviour.
    // `bands` is the analysis-side float spectrum; the page renders from
    // `freq`, so there is no reason to pay to clone it every hop.
    for (const key in f) {
      if (key === "bands") continue;
      frameMsg[key] = f[key];
    }
    post(frameMsg);
    if (f.hop - statusAt >= 60) {
      statusAt = f.hop;
      post({ type: "audio-status", status: engine.status() });
    }
  }

  function reportClientId() {
    try {
      const hydration = window.__sc_hydration;
      if (!Array.isArray(hydration)) return;
      const api = hydration.find((entry) => entry?.hydratable === "apiClient");
      if (api?.data?.id) post({ type: "client-id", id: api.data.id });
    } catch {
      // hydration isn't always present on first paint
    }
  }

  function reportAuth() {
    try {
      const match = document.cookie.match(/(?:^|; )oauth_token=([^;]+)/);
      if (match) post({ type: "oauth", token: decodeURIComponent(match[1]) });
    } catch {
      // ignore
    }
  }

  function inspectUrl(url) {
    const text = String(url || "");
    const client = text.match(/[?&]client_id=([A-Za-z0-9]{32})/);
    if (client) post({ type: "client-id", id: client[1] });
    const stream = text.match(/\/tracks\/(\d+)\/(?:streams|player|urn)/);
    if (stream) post({ type: "track-id", id: stream[1] });
    const urn = text.match(/soundcloud:sounds:(\d+)/);
    if (urn) post({ type: "track-id", id: urn[1] });
  }

  function stealAuth(headers) {
    if (!headers) return;
    try {
      const value =
        typeof headers.get === "function"
          ? headers.get("Authorization") || headers.get("authorization")
          : headers.Authorization || headers.authorization;
      if (value) post({ type: "oauth", token: value });
    } catch {
      // ignore
    }
  }

  function hookFetch() {
    const orig = window.fetch;
    if (typeof orig !== "function") return;
    window.fetch = function (...args) {
      try {
        const target = args[0];
        const url = typeof target === "string" ? target : target?.url;
        inspectUrl(url);
        stealAuth(args[1]?.headers);
        if (target && typeof target === "object" && target.headers) stealAuth(target.headers);
      } catch {
        // ignore
      }
      return orig.apply(this, args);
    };
  }

  function hookXHR() {
    const orig = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        inspectUrl(url);
      } catch {
        // ignore
      }
      return orig.call(this, method, url, ...rest);
    };
  }
})();
