"use strict";

(() => {
  let audioActive = false;
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data?.source === "scviz-control" && data.type === "audio-active") {
      audioActive = Boolean(data.active);
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

  function attachAnalyser(ctx, sourceNode) {
    if (window.__scvizAnalyser) return;
    try {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 4096;
      analyser.smoothingTimeConstant = 0.38;
      analyser.minDecibels = -90;
      analyser.maxDecibels = -22;
      sourceNode.connect(analyser);
      window.__scvizAnalyser = analyser;
      startPump(analyser);
    } catch {
      // SoundCloud may already have exclusive use of the node.
    }
  }

  function startPump(analyser) {
    if (window.__scvizPumping) return;
    window.__scvizPumping = true;

    const freqFull = new Uint8Array(analyser.frequencyBinCount);
    const timeFull = new Uint8Array(analyser.fftSize);
    const freq = new Uint8Array(256);
    const time = new Uint8Array(512);

    const tick = () => {
      const a = window.__scvizAnalyser;
      if (a && audioActive) {
        a.getByteFrequencyData(freqFull);
        a.getByteTimeDomainData(timeFull);
        logBucket(freqFull, freq, a);
        pick(timeFull, time);
        post({ type: "audio", freq, time });
      }
      if (audioActive) requestAnimationFrame(tick);
      else setTimeout(tick, 200);
    };
    tick();
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
