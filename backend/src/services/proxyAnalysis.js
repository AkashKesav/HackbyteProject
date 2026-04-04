const AI_HOST_PATTERNS = [
  { provider: "openai", match: /openai\.com$/i, defaultModel: "gpt-4.1" },
  { provider: "anthropic", match: /anthropic\.com$/i, defaultModel: "claude-3-7-sonnet" },
  { provider: "google", match: /googleapis\.com$/i, defaultModel: "gemini-2.5-pro" },
  { provider: "xai", match: /x\.ai$/i, defaultModel: "grok-3" },
];

export function analyzeProxyEvent(event, repoContext) {
  const host = event.host || "";
  const providerInfo = AI_HOST_PATTERNS.find((entry) => entry.match.test(host));
  const provider = providerInfo?.provider || event.provider || "unknown";
  const promptText = extractPromptText(event.body);
  const model = extractModel(event.body) || event.model || providerInfo?.defaultModel || null;
  const relation = scoreRepoRelation(promptText, repoContext);
  const client = detectClient(event.headers || {});

  return {
    client,
    provider,
    model,
    method: event.method || "proxy-intercept",
    relatedToRepo: relation.relatedToRepo,
    correlationScore: relation.correlationScore,
    reasons: relation.reasons,
    repoGuess: relation.repoGuess,
    promptText,
    excerpt: promptText.slice(0, 220) || "No prompt text available",
    vulnerabilities: inferVulnerabilities(promptText),
  };
}

export function createMockProxyEvent(provider, repoContext) {
  const hostMap = {
    openai: "api.openai.com",
    anthropic: "api.anthropic.com",
    google: "generativelanguage.googleapis.com",
  };

  const repoName = repoContext.summary.fullName || repoContext.summary.repoName;
  const fileHint = repoContext.fileIndex[0] || "src/index.js";

  return {
    host: hostMap[provider] || "api.openai.com",
    path: "/v1/chat/completions",
    method: "proxy-intercept",
    author: {
      login: "veeravardhan",
      name: "Veeravardhan",
    },
    headers: {
      "content-type": "application/json",
    },
    body: {
      model:
        provider === "anthropic"
          ? "claude-3-7-sonnet"
          : provider === "google"
            ? "gemini-2.5-pro"
            : "gpt-4.1",
      messages: [
        {
          role: "system",
          content: "You are helping inspect code safely.",
        },
        {
          role: "user",
          content: `Review the ${repoName} repository and explain whether ${fileHint} is vulnerable to eval or SQL injection.`,
        },
      ],
    },
  };
}

function extractPromptText(body) {
  if (!body) return "";
  if (typeof body === "string") {
    return body;
  }
  const texts = [];

  if (typeof body.prompt === "string") {
    texts.push(body.prompt);
  }

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (typeof message?.content === "string") {
        texts.push(message.content);
      } else if (Array.isArray(message?.content)) {
        for (const part of message.content) {
          if (typeof part?.text === "string") {
            texts.push(part.text);
          }
        }
      }
    }
  }

  if (typeof body.input === "string") {
    texts.push(body.input);
  }

  if (Array.isArray(body.contents)) {
    for (const item of body.contents) {
      if (typeof item?.text === "string") {
        texts.push(item.text);
      }
      if (Array.isArray(item?.parts)) {
        for (const part of item.parts) {
          if (typeof part?.text === "string") {
            texts.push(part.text);
          }
        }
      }
    }
  }

  return texts.join("\n").trim();
}

function extractModel(body) {
  if (!body || typeof body !== "object") return null;
  return body.model || body.model_name || body.metadata?.model || body.metadata?.model_name || body.metadata?.modelName || null;
}

function scoreRepoRelation(promptText, repoContext) {
  const haystack = promptText.toLowerCase();
  const reasons = [];
  let score = 0;

  for (const keyword of repoContext.keywords) {
    if (!keyword || keyword.length < 3) continue;
    if (haystack.includes(keyword)) {
      score += keyword.length > 8 ? 20 : 10;
      reasons.push(`Matched repo token "${keyword}"`);
    }
  }

  for (const filePath of repoContext.fileIndex.slice(0, 40)) {
    const fileName = filePath.split("/").pop()?.toLowerCase();
    if (fileName && haystack.includes(fileName)) {
      score += 18;
      reasons.push(`Matched file "${fileName}"`);
    }
  }

  return {
    relatedToRepo: score >= 25,
    correlationScore: Math.min(score, 100),
    reasons: reasons.slice(0, 5),
    repoGuess: repoContext.summary.fullName || repoContext.summary.repoName,
  };
}

function inferVulnerabilities(promptText) {
  const findings = [];
  const text = promptText.toLowerCase();

  if (text.includes("eval(") || text.includes("dangerouslysetinnerhtml")) {
    findings.push({
      severity: "high",
      title: "Potential code execution or unsafe HTML usage referenced",
    });
  }

  if (text.includes("select *") || text.includes("sql injection")) {
    findings.push({
      severity: "critical",
      title: "Potential SQL injection pattern referenced",
    });
  }

  if (text.includes("token") || text.includes("secret")) {
    findings.push({
      severity: "medium",
      title: "Sensitive credential handling mentioned in prompt",
    });
  }

  if (findings.length === 0) {
    findings.push({
      severity: "low",
      title: "No obvious vulnerability pattern inferred from captured prompt",
    });
  }

  return findings;
}

function detectClient(headers) {
  const userAgent = String(headers["user-agent"] || "").toLowerCase();
  const secChUa = String(headers["sec-ch-ua"] || "").toLowerCase();

  if (userAgent.includes("vscode") || userAgent.includes("visual studio code")) {
    return "vscode";
  }

  if (userAgent.includes("electron")) {
    return "electron-app";
  }

  if (userAgent.includes("firefox")) {
    return "firefox";
  }

  if (userAgent.includes("edg/")) {
    return "edge";
  }

  if (userAgent.includes("chrome") || secChUa.includes("chrome")) {
    return "chrome";
  }

  return "unknown-client";
}
