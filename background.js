"use strict";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !isSoundCloud(tab.url)) return;
  chrome.tabs.sendMessage(tab.id, { type: "scviz-toggle" }).catch(() => {});
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "toggle-visualizer") return;
  if (tab?.id && isSoundCloud(tab.url)) {
    chrome.tabs.sendMessage(tab.id, { type: "scviz-toggle" }).catch(() => {});
    return;
  }
  const [active] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (active?.id && isSoundCloud(active.url)) {
    chrome.tabs.sendMessage(active.id, { type: "scviz-toggle" }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "scviz-fetch") {
    fetchJson(message.url, message.headers)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type !== "scviz-stream-id") return;
  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ error: "no tab" });
    return;
  }
  chrome.tabCapture
    .getMediaStreamId({ targetTabId: tabId, consumerTabId: tabId })
    .then((id) => sendResponse({ id }))
    .catch((err) => sendResponse({ error: String(err?.message || err) }));
  return true;
});

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers: headers || {}, credentials: "omit" });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
}

function isSoundCloud(url) {
  try {
    const host = new URL(url).hostname;
    return host === "soundcloud.com" || host.endsWith(".soundcloud.com");
  } catch {
    return false;
  }
}
