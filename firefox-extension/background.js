const BACKEND_URL = "http://127.0.0.1:4000/api/extension/events";
const NATIVE_HOST_NAME = "commit_confessional_firefox";
const URL_PATTERNS = [
  {
    provider: "openai",
    matches: ["chatgpt.com", "openai.com"],
  },
  {
    provider: "google",
    matches: ["gemini.google.com", "generativelanguage.googleapis.com"],
  },
  {
    provider: "anthropic",
    matches: ["claude.ai", "anthropic.com"],
  },
  {
    provider: "xai",
    matches: ["x.ai"],
  },
];

const recentEvents = new Map();
const DEDUPE_WINDOW_MS = 2500;
let nativePort = null;

browser.runtime.onMessage.addListener(async (message) => {
  if (!message || message.type !== "copy-event") {
    return;
  }

  await sendEvent({
    appName: "firefox",
    eventType: "copy",
    provider: message.provider,
    url: message.url,
    method: "COPY",
    tabTitle: message.tabTitle || "",
    browser: "firefox",
    contentHash: message.contentHash || null,
    clipboardPreview: message.preview || "",
    contentText: message.contentText || "",
    copiedLength: message.copiedLength || 0,
  });
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url) {
    return;
  }

  const match = matchProvider(tab.url);
  if (!match) {
    return;
  }

  await sendEvent({
    eventType: "tab-visit",
    provider: match.provider,
    url: tab.url,
    tabTitle: tab.title || "",
    browser: "firefox",
    method: "GET",
  });
});

browser.webRequest.onBeforeRequest.addListener(
  async (details) => {
    if (!details?.url) {
      return;
    }

    const match = matchProvider(details.url);
    if (!match) {
      return;
    }

    const tabTitle = await lookupTabTitle(details.tabId);
    await sendEvent({
      eventType: "network-request",
      provider: match.provider,
      url: details.url,
      method: details.method || "GET",
      requestType: details.type || "unknown",
      tabId: details.tabId,
      tabTitle,
      browser: "firefox",
      requestId: details.requestId,
      timeStamp: details.timeStamp,
      originUrl: details.originUrl || "",
      documentUrl: details.documentUrl || "",
    });
  },
  { urls: ["<all_urls>"] }
);

function matchProvider(rawUrl) {
  let hostname = "";

  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }

  for (const entry of URL_PATTERNS) {
    if (entry.matches.some((value) => hostname === value || hostname.endsWith(`.${value}`))) {
      return { provider: entry.provider, hostname };
    }
  }

  return null;
}

async function lookupTabTitle(tabId) {
  if (typeof tabId !== "number" || tabId < 0) {
    return "";
  }

  try {
    const tab = await browser.tabs.get(tabId);
    return tab?.title || "";
  } catch {
    return "";
  }
}

async function sendEvent(payload) {
  const dedupeKey = [payload.eventType, payload.method, payload.url, payload.tabTitle].join("|");
  const now = Date.now();
  const lastSentAt = recentEvents.get(dedupeKey);

  if (lastSentAt && now - lastSentAt < DEDUPE_WINDOW_MS) {
    return;
  }

  recentEvents.set(dedupeKey, now);
  pruneRecentEvents(now);

  try {
    writeToNativeHost({
      ts: new Date().toISOString(),
      ...payload,
    });
    await fetch(BACKEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.error("Failed to send extension event to backend", error);
  }
}

function writeToNativeHost(payload) {
  try {
    if (!nativePort) {
      nativePort = browser.runtime.connectNative(NATIVE_HOST_NAME);
      nativePort.onDisconnect.addListener(() => {
        nativePort = null;
      });
    }

    nativePort.postMessage(payload);
  } catch (error) {
    console.warn("Native host unavailable, falling back to extension storage", error);
    browser.storage.local.set({
      lastCommitConfessionalEvent: payload,
    });
  }
}

function pruneRecentEvents(now) {
  for (const [key, timestamp] of recentEvents.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS * 2) {
      recentEvents.delete(key);
    }
  }
}
