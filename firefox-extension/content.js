(function () {
  const PROVIDER_PATTERNS = [
    { provider: "openai", matches: ["chatgpt.com", "openai.com"] },
    { provider: "google", matches: ["gemini.google.com"] },
    { provider: "anthropic", matches: ["claude.ai", "anthropic.com"] },
    { provider: "xai", matches: ["x.ai"] },
  ];

  document.addEventListener("copy", () => {
    void handleCopy();
  });

  async function handleCopy() {
    const selection = String(window.getSelection?.() || "").trim();
    if (!selection || selection.length < 20) {
      return;
    }

    const provider = detectProvider(window.location.hostname);
    if (!provider) {
      return;
    }

    const contentHash = await hashText(selection);
    browser.runtime.sendMessage({
      type: "copy-event",
      provider,
      url: window.location.href,
      tabTitle: document.title || "",
      preview: selection.length > 180 ? `${selection.slice(0, 177)}...` : selection,
      contentText: selection,
      copiedLength: selection.length,
      contentHash,
    });
  }

  function detectProvider(hostname) {
    const value = String(hostname || "").toLowerCase();
    for (const entry of PROVIDER_PATTERNS) {
      if (entry.matches.some((match) => value === match || value.endsWith(`.${match}`))) {
        return entry.provider;
      }
    }
    return null;
  }

  async function hashText(value) {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    const encoded = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    const bytes = Array.from(new Uint8Array(digest));
    return `sha256:${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
})();
