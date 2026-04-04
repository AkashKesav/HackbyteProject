import { useEffect, useState } from "react";

const API_BASE = "http://localhost:4000";

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [githubMessage, setGithubMessage] = useState("");

  async function loadDashboard() {
    const response = await fetch(`${API_BASE}/api/dashboard`);
    const data = await response.json();
    setDashboard(data);
  }

  useEffect(() => {
    loadDashboard();
    const interval = window.setInterval(loadDashboard, 5000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const github = params.get("github");
    const reason = params.get("reason");
    if (!github) {
      return;
    }

    if (github === "connected") {
      setGithubMessage("GitHub account connected.");
    } else if (github === "error") {
      setGithubMessage(`GitHub connection failed${reason ? `: ${reason}` : ""}`);
    }

    params.delete("github");
    params.delete("reason");
    const next = params.toString();
    window.history.replaceState({}, "", next ? `${window.location.pathname}?${next}` : window.location.pathname);
    void loadDashboard();
  }, []);

  async function connectGithub() {
    setConnecting(true);
    try {
      const response = await fetch(`${API_BASE}/api/github/connect`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.message || "GitHub OAuth is not configured.");
      }
      window.location.href = data.authorizationUrl;
    } catch (error) {
      setGithubMessage(error.message || String(error));
    } finally {
      setConnecting(false);
    }
  }

  async function disconnectGithub() {
    await fetch(`${API_BASE}/api/github/logout`, { method: "POST" });
    setGithubMessage("GitHub account disconnected.");
    await loadDashboard();
  }

  async function simulate(provider) {
    setSimulating(true);
    try {
      await fetch(`${API_BASE}/api/proxy/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      await loadDashboard();
    } finally {
      setSimulating(false);
    }
  }

  async function clearEvents() {
    await fetch(`${API_BASE}/api/proxy/events`, { method: "DELETE" });
    await loadDashboard();
  }

  if (!dashboard) {
    return <div className="grid min-h-screen place-items-center bg-stone-950 text-stone-100">Loading dashboard...</div>;
  }

  const latestCapture = dashboard.captures[0];
  const latestReceipt = dashboard.latestReceipt;
  const receiptContribution = latestReceipt?.modelEvidence?.contribution ?? null;
  const receiptCopilot = latestReceipt?.copilotContribution ?? latestReceipt?.modelEvidence?.copilotContribution ?? null;
  const github = dashboard.github;
  const commitTime = formatDateTime(dashboard.latestCommit?.authoredAt);
  const receiptUpdatedTime = formatDateTime(latestReceipt?.updatedAt);
  const recentCommits = Array.isArray(dashboard.recentCommits) ? dashboard.recentCommits : [];

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(21,128,61,0.24),_transparent_32%),linear-gradient(135deg,_#0c0a09,_#1c1917_48%,_#0f172a)] text-stone-100">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 md:px-6">
        <section className="overflow-hidden rounded-[28px] border border-white/10 bg-black/30 shadow-2xl shadow-black/30 backdrop-blur">
          <div className="grid gap-8 p-6 md:grid-cols-[1.2fr_0.8fr] md:p-8">
            <div>
              <p className="text-xs uppercase tracking-[0.4em] text-emerald-300/80">Commit Confessional</p>
              <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-tight text-white md:text-5xl">
                Track AI-assisted coding from capture through commit, with live evidence and narration.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-300">
                This dashboard now combines local capture events, commit receipts, and GitHub connection state so you can see when code was committed, how much AI likely contributed, and who the repo is connected to.
              </p>
              {githubMessage ? (
                <div className="mt-4 rounded-2xl border border-emerald-400/20 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100">
                  {githubMessage}
                </div>
              ) : null}
              <div className="mt-6 flex flex-wrap gap-3">
                <button
                  onClick={connectGithub}
                  disabled={connecting}
                  className="rounded-full bg-white px-5 py-3 text-sm font-medium text-stone-950 transition hover:bg-emerald-200 disabled:opacity-60"
                >
                  {connecting ? "Connecting..." : github?.connected ? "Reconnect GitHub" : "Connect GitHub"}
                </button>
                {github?.connected ? (
                  <button
                    onClick={disconnectGithub}
                    className="rounded-full border border-white/15 px-5 py-3 text-sm font-medium text-stone-200 transition hover:bg-white/5"
                  >
                    Disconnect GitHub
                  </button>
                ) : null}
                <button
                  onClick={() => simulate("openai")}
                  disabled={simulating}
                  className="rounded-full border border-emerald-400/50 bg-emerald-500/10 px-5 py-3 text-sm font-medium text-emerald-100 transition hover:bg-emerald-500/20 disabled:opacity-60"
                >
                  {simulating ? "Simulating..." : "Simulate OpenAI proxy event"}
                </button>
                <button
                  onClick={clearEvents}
                  className="rounded-full border border-white/15 px-5 py-3 text-sm font-medium text-stone-200 transition hover:bg-white/5"
                >
                  Clear events
                </button>
              </div>
            </div>

            <div className="grid gap-4">
              <StatusCard
                title="Proxy status"
                value={dashboard.proxy.healthy ? "Receiving events" : "Waiting for first event"}
                accent={dashboard.proxy.healthy ? "text-emerald-300" : "text-amber-300"}
                details={[
                  `Source: ${dashboard.proxy.eventSource}`,
                  `Captured events: ${dashboard.proxy.totalEvents}`,
                  `Last event: ${dashboard.proxy.lastEventAt ?? "none yet"}`,
                ]}
              />
              <StatusCard
                title="Repository"
                value={dashboard.repo.fullName || dashboard.repo.repoName}
                accent="text-sky-300"
                details={[
                  `Branch: ${dashboard.repo.branch ?? "unknown"}`,
                  `Remote: ${dashboard.repo.remoteUrl ?? "not configured"}`,
                ]}
              />
              <StatusCard
                title="Latest commit"
                value={dashboard.latestCommit.subject}
                accent="text-fuchsia-300"
                details={[
                  `Author: ${dashboard.latestCommit.authorName ?? "unknown"}`,
                  `Hash: ${dashboard.latestCommit.shortHash ?? "unknown"}`,
                  `Authored: ${commitTime}`,
                  `Classification: ${dashboard.latestCommit.classification}`,
                ]}
              />
              <StatusCard
                title="AI contribution"
                value={
                  receiptContribution
                    ? `${receiptContribution.estimatedAiPercentage}% AI`
                    : "No receipt yet"
                }
                accent="text-emerald-300"
                details={[
                  receiptCopilot
                    ? `Copilot: ${receiptCopilot.estimatedAiPercentage}%`
                    : "Copilot: no receipt yet",
                  latestReceipt?.modelEvidence?.method
                    ? `Method: ${latestReceipt.modelEvidence.method}`
                    : "Method: waiting for first commit receipt",
                  latestReceipt?.updatedAt ? `Updated: ${receiptUpdatedTime}` : "Run a commit to populate this",
                ]}
              />
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 backdrop-blur">
            <div>
              <h2 className="text-xl font-semibold text-white">Captured AI events</h2>
              <p className="mt-1 text-sm text-stone-400">
                These records are what you will later map to contributors, commits, and vulnerability scans.
              </p>
            </div>

            <div className="mt-5 space-y-3">
              {dashboard.captures.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/15 bg-black/20 p-6 text-sm text-stone-400">
                  No proxy captures yet. Use the simulate action or POST real events from your local proxy to
                  `POST /api/proxy/events`.
                </div>
              ) : (
                dashboard.captures.map((capture) => (
                  <article key={capture.id} className="rounded-2xl border border-white/10 bg-black/25 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-200">
                            {capture.provider}
                          </span>
                          <span className="rounded-full bg-sky-500/15 px-3 py-1 text-xs font-medium text-sky-200">
                            {capture.model || "unknown model"}
                          </span>
                          <span
                            className={`rounded-full px-3 py-1 text-xs font-medium ${
                              capture.relatedToRepo
                                ? "bg-emerald-500/15 text-emerald-200"
                                : "bg-amber-500/15 text-amber-200"
                            }`}
                          >
                            {capture.relatedToRepo ? "repo-related" : "not confidently related"}
                          </span>
                        </div>
                        <h3 className="mt-3 text-lg font-medium text-white">{capture.endpoint}</h3>
                        <p className="mt-2 text-sm leading-6 text-stone-300">{capture.excerpt}</p>
                      </div>
                      <div className="min-w-40 rounded-2xl bg-white/5 p-3 text-sm text-stone-300">
                        <div>{capture.author.name}</div>
                        <div className="mt-1 text-xs text-stone-500">{capture.capturedAt}</div>
                        <div className="mt-3 text-xs uppercase tracking-[0.25em] text-stone-500">Correlation</div>
                        <div className="mt-1 text-2xl font-semibold text-white">{capture.correlationScore}</div>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-4 md:grid-cols-2">
                      <div>
                        <p className="text-xs uppercase tracking-[0.25em] text-stone-500">Why it matched</p>
                        <ul className="mt-2 space-y-2 text-sm text-stone-300">
                          {capture.correlationReasons.map((reason) => (
                            <li key={reason} className="rounded-xl bg-white/5 px-3 py-2">
                              {reason}
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <p className="text-xs uppercase tracking-[0.25em] text-stone-500">Vulnerability hints</p>
                        <div className="mt-2 space-y-2">
                          {capture.vulnerabilities.map((finding) => (
                            <div key={finding.title} className="rounded-xl bg-white/5 px-3 py-2 text-sm text-stone-300">
                              <span className="mr-2 inline-block rounded-full bg-rose-500/15 px-2 py-1 text-xs uppercase tracking-[0.2em] text-rose-200">
                                {finding.severity}
                              </span>
                              {finding.title}
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </article>
                ))
              )}
            </div>
          </div>

          <div className="grid gap-6">
            <Panel title="Recent commits">
              {recentCommits.length === 0 ? (
                <p className="text-sm text-stone-400">
                  No commits available yet. Connect GitHub or make a local commit to populate this list.
                </p>
              ) : (
                recentCommits.map((commit) => (
                  <div key={commit.hash || commit.shortHash} className="rounded-2xl bg-black/20 p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-white">{commit.subject}</div>
                        <div className="mt-1 text-xs text-stone-400">
                          {(commit.authorName || "Unknown author")} • {formatDateTime(commit.authoredAt)} •{" "}
                          {commit.shortHash || "unknown"}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-emerald-300">
                          {commit.ai ? `${commit.ai.estimatedAiPercentage}% AI` : "AI unknown"}
                        </div>
                        <div className="mt-1 text-xs text-stone-400">
                          {commit.copilot ? `${commit.copilot.estimatedAiPercentage}% Copilot` : "Copilot unknown"}
                        </div>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <span className="rounded-full bg-white/5 px-3 py-1 text-stone-300">
                        Certainty: {commit.ai?.certainty ?? "unknown"}
                      </span>
                      <span className="rounded-full bg-white/5 px-3 py-1 text-stone-300">
                        Method: {commit.ai?.method ?? "waiting for receipt"}
                      </span>
                      <span className="rounded-full bg-white/5 px-3 py-1 text-stone-300">
                        Matched lines: {commit.ai ? `${commit.ai.aiMatchedLines}/${commit.ai.totalChangedLines}` : "--"}
                      </span>
                    </div>
                    {commit.htmlUrl ? (
                      <a
                        href={commit.htmlUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex rounded-full border border-sky-400/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20"
                      >
                        Open commit on GitHub
                      </a>
                    ) : null}
                  </div>
                ))
              )}
            </Panel>

            <Panel title="Analysis summary">
              <MetricRow label="AI-related captures" value={String(dashboard.analytics.aiAssistedCommits)} />
              <MetricRow
                label="Latest commit AI"
                value={receiptContribution ? `${receiptContribution.estimatedAiPercentage}%` : "--"}
              />
              <MetricRow
                label="Latest commit Copilot"
                value={receiptCopilot ? `${receiptCopilot.estimatedAiPercentage}%` : "--"}
              />
              {dashboard.analytics.vulnerabilities.map((item) => (
                <MetricRow key={item.severity} label={`${item.severity} findings`} value={String(item.count)} />
              ))}
            </Panel>

            <Panel title="Latest commit receipt">
              {latestReceipt ? (
                <>
                  <MetricRow
                    label="Confidence"
                    value={latestReceipt.modelEvidence?.certainty ?? "NONE"}
                  />
                  <MetricRow
                    label="Matched lines"
                    value={
                      receiptContribution
                        ? `${receiptContribution.aiMatchedLines}/${receiptContribution.totalChangedLines}`
                        : "0/0"
                    }
                  />
                  <MetricRow
                    label="Commit"
                    value={dashboard.latestCommit?.shortHash ?? "--"}
                  />
                  <MetricRow
                    label="Committed at"
                    value={commitTime}
                  />
                  <div className="space-y-2 text-sm text-stone-300">
                    {(latestReceipt.modelEvidence?.evidence ?? []).length === 0 ? (
                      <div className="rounded-2xl bg-white/5 px-4 py-3 text-stone-400">
                        No commit evidence yet.
                      </div>
                    ) : (
                      latestReceipt.modelEvidence.evidence.map((item) => (
                        <div key={item} className="rounded-2xl bg-white/5 px-4 py-3">
                          {item}
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : (
                <p className="text-sm text-stone-400">
                  No commit receipt yet. Commit once while the backend is running and the dashboard will show the percentage here.
                </p>
              )}
            </Panel>

            <Panel title="GitHub connection">
              {github?.connected ? (
                <div className="space-y-3 text-sm text-stone-300">
                  <MetricRow label="Login" value={github.user?.login ?? "--"} />
                  <MetricRow label="Name" value={github.user?.name ?? "--"} />
                  <MetricRow label="Connected" value={formatDateTime(github.connectedAt)} />
                  {github.user?.profileUrl ? (
                    <a
                      href={github.user.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex rounded-full border border-sky-400/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-100 transition hover:bg-sky-500/20"
                    >
                      Open GitHub profile
                    </a>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-stone-400">
                  GitHub is not connected yet. Add `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` to `.env`, then connect from this dashboard.
                </p>
              )}
            </Panel>

            <Panel title="Contributors">
              {dashboard.analytics.contributors.length === 0 ? (
                <p className="text-sm text-stone-400">No contributors detected yet. Proxy events will populate this.</p>
              ) : (
                dashboard.analytics.contributors.map((contributor) => (
                  <div key={contributor.login} className="rounded-2xl bg-white/5 p-3">
                    <div className="text-sm font-medium text-white">{contributor.name}</div>
                    <div className="mt-2 flex justify-between text-xs text-stone-400">
                      <span>{contributor.events} captured events</span>
                      <span>{contributor.relatedEvents} repo-related</span>
                    </div>
                  </div>
                ))
              )}
            </Panel>

            <Panel title="Limits you need to respect">
              <ul className="space-y-3 text-sm leading-6 text-stone-300">
                {dashboard.analytics.unsupportedCapabilities.map((item) => (
                  <li key={item} className="rounded-2xl bg-amber-500/10 px-4 py-3 text-amber-100">
                    {item}
                  </li>
                ))}
              </ul>
            </Panel>

            {latestCapture && (
              <Panel title="Next wire-up step">
                <p className="text-sm leading-6 text-stone-300">
                  Your local proxy should POST captures shaped like the current simulation to
                  `http://localhost:4000/api/proxy/events`. Once that works with trusted TLS interception, you can map
                  these events to Git commits and authors.
                </p>
              </Panel>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}

function formatDateTime(value) {
  if (!value) {
    return "unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function StatusCard({ title, value, details, accent }) {
  return (
    <div className="rounded-[24px] border border-white/10 bg-white/5 p-5">
      <p className="text-xs uppercase tracking-[0.3em] text-stone-500">{title}</p>
      <div className={`mt-3 text-2xl font-semibold ${accent}`}>{value}</div>
      <div className="mt-3 space-y-1 text-sm text-stone-400">
        {details.map((detail) => (
          <div key={detail}>{detail}</div>
        ))}
      </div>
    </div>
  );
}

function Panel({ title, children }) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/5 p-5 backdrop-blur">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function MetricRow({ label, value }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-black/20 px-4 py-3">
      <span className="text-sm text-stone-300">{label}</span>
      <span className="text-lg font-semibold text-white">{value}</span>
    </div>
  );
}
