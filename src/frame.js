"use strict";

(() => {
  let lastSent = "";
  let timer = 0;
  let observer;

  const send = () => {
    try {
      const payload = {
        source: "scviz-frame",
        comments: scrapeComments(),
        trackUrl: scrapeTrackUrl(),
        samples: scrapeWaveform(),
      };
      const key = JSON.stringify({
        url: payload.trackUrl,
        n: payload.comments.length,
        s: payload.samples.length,
      });
      if (key === lastSent) return;
      lastSent = key;
      window.top.postMessage(payload, "*");
    } catch {
      if (timer) clearInterval(timer);
      observer?.disconnect();
    }
  };

  send();
  timer = setInterval(send, 1500);
  observer = new MutationObserver(send);
  try {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  } catch {
    clearInterval(timer);
  }

  function scrapeTrackUrl() {
    try {
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        const data = JSON.parse(script.textContent || "null");
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          if (item?.["@type"] === "MusicRecording" && item.url) return item.url;
        }
      }
    } catch {
      // ignore
    }
    return permalinkFromPath(location.pathname);
  }

  function permalinkFromPath(pathname) {
    const clean = pathname.replace(/^\/n\//, "/");
    const parts = clean.split("/").filter(Boolean);
    if (parts.length >= 2 && !reserved.has(parts[0])) {
      return `${location.origin}/${parts[0]}/${parts[1]}`;
    }
    return "";
  }

  function scrapeWaveform() {
    const slider = document.querySelector('[aria-label="Waveform"]');
    const svg = slider?.querySelector("svg");
    if (!svg) return [];
    const rects = [...svg.querySelectorAll("rect")];
    if (rects.length < 8) return [];
    const samples = [];
    for (let i = 0; i < rects.length; i += 2) {
      samples.push(parseFloat(rects[i].getAttribute("height")) || 0);
    }
    return samples;
  }

  function scrapeComments() {
    const found = [];
    for (const el of document.querySelectorAll('[aria-label*="commented at"]')) {
      const label = el.getAttribute("aria-label") || "";
      const parsed = parseCommentLabel(label);
      if (!parsed) continue;
      const root = el.closest("[class]")?.parentElement || el.parentElement;
      const body =
        root?.querySelector("p")?.textContent?.trim() ||
        el.parentElement?.parentElement?.querySelector("p")?.textContent?.trim() ||
        "";
      const avatar = root?.querySelector("img")?.src || "";
      found.push({
        id: label,
        t: parsed.seconds,
        body,
        user: parsed.user,
        avatar,
      });
    }
    return found;
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
    "signin",
    "login",
  ]);
})();
