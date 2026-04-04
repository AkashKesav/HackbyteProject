import { useEffect, useState } from "react";

const API_BASE = "http://localhost:4000";

export default function App() {
  const [dashboard, setDashboard] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [githubMessage, setGithubMessage] = useState("");
  const currentPath = window.location.pathname;
  const isGithubLoginPage = currentPath === "/github-login";

  async function loadDashboard() {
    const response = await fetch(`${API_BASE}/api/dashboard`);
    const data = await response.json();
    setDashboard(data);
  }

  useEffect(() => {
    void loadDashboard();
    const interval = window.setInterval(() => void loadDashboard(), 2000);
    const refreshOnFocus = () => void loadDashboard();
    const refreshOnVisible = () => {
      if (document.visibilityState === "visible") {
        void loadDashboard();
      }
    };

    window.addEventListener("focus", refreshOnFocus);
    document.addEventListener("visibilitychange", refreshOnVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnFocus);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
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

  async function connectGithub(returnPath = currentPath || "/github-login") {
    setConnecting(true);
    try {
      const response = await fetch(`${API_BASE}/api/github/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnPath }),
      });
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
    return <div className="grid min-h-screen place-items-center bg-[#0b0d12] text-[#edf0fa]">Loading dashboard...</div>;
  }

  const latestCapture = dashboard.captures[0];
  const latestReceipt = dashboard.latestCommitReceipt || dashboard.latestReceipt;
  const receiptContribution = latestReceipt?.modelEvidence?.contribution ?? null;
  const receiptCopilot = latestReceipt?.copilotContribution ?? latestReceipt?.modelEvidence?.copilotContribution ?? null;
  const receiptModel = latestReceipt?.modelEvidence?.model || latestCapture?.model || "unknown";
  const dependencyAudit = latestReceipt?.dependencyAudit || null;
  const github = dashboard.github;
  const recentCommits = Array.isArray(dashboard.recentCommits) ? dashboard.recentCommits : [];
  const repoName = dashboard.repo.fullName || dashboard.repo.repoName || "unknown-repo";
  const connectedLabel = github?.connected ? github.user?.login || "connected" : "not connected";

  if (isGithubLoginPage) {
    return (
      <GithubLoginPage
        repoName={repoName}
        github={github}
        githubMessage={githubMessage}
        connecting={connecting}
        onConnect={() => connectGithub("/github-login")}
        onDisconnect={disconnectGithub}
      />
    );
  }

  return (
    <main className="min-h-screen bg-[#0b0d12] text-[#edf0fa]">
      <TopBar repoName={repoName} connectedLabel={connectedLabel} githubConnected={github?.connected} />

      <div className="flex min-h-[calc(100vh-52px)]">
        <aside className="hidden w-[228px] shrink-0 border-r border-[#252c3e] bg-[#11141c] p-3 xl:block">
          <SidebarSection title="Workspace">
            <SidebarItem active>{repoName}</SidebarItem>
            <SidebarItem>{dashboard.repo.branch || "no-branch"}</SidebarItem>
            <SidebarItem>{dashboard.proxy.eventSource || "simulation"}</SidebarItem>
          </SidebarSection>
          <SidebarSection title="Tracking">
            <SidebarItem active={dashboard.proxy.healthy}>Proxy events</SidebarItem>
            <SidebarItem active={Boolean(latestReceipt)}>Latest receipt</SidebarItem>
            <SidebarItem active={github?.connected}>GitHub OAuth</SidebarItem>
            <SidebarItem active={recentCommits.length > 0}>Commit history</SidebarItem>
          </SidebarSection>
          <SidebarSection title="Summary">
            <SidebarMetric label="AI %" value={receiptContribution ? `${receiptContribution.estimatedAiPercentage}%` : "--"} />
            <SidebarMetric label="Copilot %" value={receiptCopilot ? `${receiptCopilot.estimatedAiPercentage}%` : "--"} />
            <SidebarMetric label="CVEs" value={dependencyAudit ? String(dependencyAudit.findingCount || 0) : "--"} />
            <SidebarMetric label="Events" value={String(dashboard.proxy.totalEvents || 0)} />
            <SidebarMetric label="Contribs" value={String(dashboard.analytics.contributors.length)} />
          </SidebarSection>
        </aside>

        <div className="flex-1 p-4 md:p-5 xl:p-6">
          <section className="rounded-2xl border border-[#252c3e] bg-[#11141c] p-5 shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
            <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
              <div className="max-w-3xl">
                <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#4a5578]">Commit Confessional</div>
                <h1 className="mt-3 font-mono text-3xl font-bold tracking-tight text-[#edf0fa] md:text-4xl">
                  AI provenance, commit risk, and repo activity in one control surface.
                </h1>
                <p className="mt-3 max-w-2xl text-sm leading-6 text-[#8492b4]">
                  The dashboard now follows the security-console direction from your mockup: compact telemetry, clear
                  status chips, and commit-level AI evidence immediately visible.
                </p>
                {githubMessage ? (
                  <div className="mt-4 rounded-xl border border-[#313a54] bg-[#181d28] px-4 py-3 text-sm text-[#c7d1eb]">
                    {githubMessage}
                  </div>
                ) : null}
                <div className="mt-5 flex flex-wrap gap-3">
                  <ActionButton onClick={connectGithub} disabled={connecting} active>
                    {connecting ? "Connecting..." : github?.connected ? "Reconnect GitHub" : "Connect GitHub"}
                  </ActionButton>
                  <ActionLink href="/github-login">GitHub login page</ActionLink>
                  {github?.connected ? <ActionButton onClick={disconnectGithub}>Disconnect</ActionButton> : null}
                  <ActionButton onClick={() => simulate("openai")} disabled={simulating}>
                    {simulating ? "Simulating..." : "Simulate proxy event"}
                  </ActionButton>
                  <ActionButton onClick={clearEvents}>Clear events</ActionButton>
                </div>
              </div>

              <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:w-[360px] xl:grid-cols-1">
                <HighlightCard
                  label="Latest commit AI"
                  value={receiptContribution ? `${receiptContribution.estimatedAiPercentage}%` : "--"}
                  accent={scoreTone(receiptContribution?.estimatedAiPercentage ?? 0)}
                  detailTop={dashboard.latestCommit?.subject || "No commit"}
                  detailBottom={`Updated ${formatDateTime(latestReceipt?.updatedAt)}`}
                />
                <HighlightCard
                  label="GitHub"
                  value={github?.connected ? "Connected" : "Offline"}
                  accent={github?.connected ? "text-[#1fc86b]" : "text-[#f5a623]"}
                  detailTop={github?.user?.name || "No linked profile"}
                  detailBottom={github?.user?.profileUrl || dashboard.repo.remoteUrl || "Local only"}
                />
              </div>
            </div>
          </section>

          <section className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Commit score"
              value={receiptContribution ? `${receiptContribution.estimatedAiPercentage}%` : "--"}
              sub={dashboard.latestCommit?.shortHash || "waiting"}
              tone={scoreTone(receiptContribution?.estimatedAiPercentage ?? 0)}
            />
            <StatCard
              label="Copilot use"
              value={receiptCopilot ? `${receiptCopilot.estimatedAiPercentage}%` : "--"}
              sub={`${receiptModel} | ${latestReceipt?.modelEvidence?.method || "no method"}`}
              tone="text-[#f5a623]"
            />
            <StatCard
              label="Proxy events"
              value={String(dashboard.proxy.totalEvents || 0)}
              sub={dashboard.proxy.healthy ? "stream active" : "idle"}
              tone={dashboard.proxy.healthy ? "text-[#1fc86b]" : "text-[#f5a623]"}
            />
            <StatCard
              label="Contributors"
              value={String(dashboard.analytics.contributors.length)}
              sub={github?.connected ? "repo linked" : "local mode"}
              tone="text-[#4d8eff]"
            />
          </section>

          <section className="mt-4 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
            <Panel title="Recent commits" subtitle="Latest local or GitHub commit feed with AI evidence attached.">
              {recentCommits.length === 0 ? (
                <EmptyState text="No commits available yet. Connect GitHub or make a local commit." />
              ) : (
                <div className="overflow-hidden rounded-xl border border-[#252c3e]">
                  <div className="grid grid-cols-[minmax(0,1.6fr)_100px_110px_90px] gap-3 border-b border-[#252c3e] bg-[#181d28] px-4 py-3 font-mono text-[10px] uppercase tracking-[0.18em] text-[#4a5578]">
                    <div>Commit</div>
                    <div>AI %</div>
                    <div>Copilot %</div>
                    <div>Certainty</div>
                  </div>
                  {recentCommits.map((commit, idx) => {
                    const isLatestCommit = idx === 0;
                    const aiPercentage = commit.ai?.estimatedAiPercentage ?? 0;
                    const hasAiData = commit.ai !== undefined && commit.ai !== null;
                    return (
                    <div
                      key={commit.hash || commit.shortHash}
                      className={`grid grid-cols-1 gap-3 border-b border-[#252c3e] px-4 py-4 last:border-b-0 md:grid-cols-[minmax(0,1.6fr)_100px_110px_90px] ${isLatestCommit && hasAiData ? 'bg-[#1a1f2e] ring-1 ring-inset ring-[#3d5a80]' : 'bg-[#11141c]'}`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <div className="truncate text-sm font-medium text-[#edf0fa]">{commit.subject}</div>
                          {isLatestCommit && hasAiData && (
                            <span className="inline-block shrink-0 rounded-full bg-[#1fc86b] px-2 py-1 font-mono text-[9px] font-bold uppercase tracking-widest text-[#0b0d12]">
                              NEW
                            </span>
                          )}
                        </div>
                        <div className="mt-1 text-xs text-[#8492b4]">
                          {(commit.authorName || "Unknown author")} | {formatDateTime(commit.authoredAt)} |{" "}
                          {commit.shortHash || "unknown"}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <MiniChip tone="blu">{commit.ai?.method || "waiting for receipt"}</MiniChip>
                          <MiniChip tone={chipTone(commit.ai?.certainty)}>{commit.ai?.certainty || "unknown"}</MiniChip>
                          <MiniChip tone="gry">
                            {commit.ai ? `${commit.ai.aiMatchedLines}/${commit.ai.totalChangedLines} matched` : "no diff score"}
                          </MiniChip>
                        </div>
                      </div>
                      <CellValue value={commit.ai ? `${commit.ai.estimatedAiPercentage}%` : "--"} tone={scoreTone(commit.ai?.estimatedAiPercentage ?? 0)} />
                      <CellValue value={commit.copilot ? `${commit.copilot.estimatedAiPercentage}%` : "--"} tone="text-[#f5a623]" />
                      <CellValue value={commit.ai?.certainty || "--"} tone={certaintyTone(commit.ai?.certainty)} />
                    </div>
                    );
                  })}
                </div>
              )}
            </Panel>

            <div className="grid gap-4">
              <Panel title="Latest receipt" subtitle="Current commit receipt and evidence stream.">
                {latestReceipt ? (
                  <>
                    <MetricRow label="Commit" value={dashboard.latestCommit?.shortHash ?? "--"} />
                    <MetricRow label="Authored" value={formatDateTime(dashboard.latestCommit?.authoredAt)} />
                    <MetricRow label="AI usage" value={receiptContribution ? `${receiptContribution.estimatedAiPercentage}%` : "--"} />
                    <MetricRow label="Copilot usage" value={receiptCopilot ? `${receiptCopilot.estimatedAiPercentage}%` : "--"} />
                    <MetricRow label="Model" value={receiptModel} />
                    <MetricRow
                      label="Matched lines"
                      value={receiptContribution ? `${receiptContribution.aiMatchedLines}/${receiptContribution.totalChangedLines}` : "0/0"}
                    />
                    <MetricRow label="Confidence" value={latestReceipt.modelEvidence?.certainty ?? "NONE"} />
                    <MetricRow
                      label="Semgrep findings"
                      value={latestReceipt.semgrep?.available ? String(latestReceipt.semgrep?.findingCount || 0) : latestReceipt.semgrep?.error || "unavailable"}
                    />
                    <MetricRow label="Semgrep severity" value={latestReceipt.semgrep?.highestSeverity || "none"} />
                    <MetricRow
                      label="Dependency CVEs"
                      value={dependencyAudit?.available ? String(dependencyAudit.findingCount || 0) : dependencyAudit?.error || "unavailable"}
                    />
                    <MetricRow
                      label="Affected packages"
                      value={dependencyAudit?.available ? String(dependencyAudit.affectedPackageCount || 0) : "--"}
                    />
                    <MetricRow label="Dependency severity" value={dependencyAudit?.highestSeverity || "none"} />
                    <div className="space-y-2">
                      {(latestReceipt.modelEvidence?.evidence ?? []).length === 0 ? (
                        <EmptyState text="No evidence text was produced for the latest receipt." compact />
                      ) : (
                        latestReceipt.modelEvidence.evidence.map((item) => (
                          <div key={item} className="rounded-xl border border-[#252c3e] bg-[#181d28] px-4 py-3 text-sm text-[#c7d1eb]">
                            {item}
                          </div>
                        ))
                      )}
                    </div>
                    {(latestReceipt.semgrep?.findings ?? []).length > 0 ? (
                      <div className="space-y-2">
                        {latestReceipt.semgrep.findings.slice(0, 5).map((finding) => (
                          <div
                            key={`${finding.rule}-${finding.path}-${finding.line}`}
                            className="rounded-xl border border-[#252c3e] bg-[#181d28] px-4 py-3 text-sm text-[#c7d1eb]"
                          >
                            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#4a5578]">
                              {finding.severity} | {finding.rule}
                            </div>
                            <div className="mt-1 text-[#edf0fa]">{finding.message}</div>
                            <div className="mt-1 text-xs text-[#8492b4]">
                              {finding.path}
                              {finding.line ? `:${finding.line}` : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                    {(dependencyAudit?.findings ?? []).length > 0 ? (
                      <div className="space-y-2">
                        {dependencyAudit.findings.slice(0, 5).map((finding) => (
                          <div
                            key={`${finding.project}-${finding.package}-${finding.advisory || finding.title}`}
                            className="rounded-xl border border-[#252c3e] bg-[#181d28] px-4 py-3 text-sm text-[#c7d1eb]"
                          >
                            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-[#4a5578]">
                              {finding.severity} | {finding.package}
                            </div>
                            <div className="mt-1 text-[#edf0fa]">{finding.advisory || finding.title}</div>
                            <div className="mt-1 text-xs text-[#8492b4]">
                              {finding.project || "root"}
                              {finding.fixAvailable ? ` | fix ${finding.fixAvailable}` : ""}
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </>
                ) : (
                  <EmptyState text="No commit receipt yet. Make a commit while the extension and backend are running." compact />
                )}
              </Panel>

              <Panel title="GitHub connection" subtitle="OAuth status and connected account.">
                {github?.connected ? (
                  <div className="space-y-3">
                    <MetricRow label="Login" value={github.user?.login ?? "--"} />
                    <MetricRow label="Name" value={github.user?.name ?? "--"} />
                    <MetricRow label="Connected" value={formatDateTime(github.connectedAt)} />
                    {github.user?.profileUrl ? (
                      <a
                        href={github.user.profileUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex rounded-lg border border-[#313a54] bg-[#0d1e3d] px-4 py-2 font-mono text-[11px] text-[#4d8eff] transition hover:border-[#4d8eff]/50"
                      >
                        Open GitHub profile
                      </a>
                    ) : null}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <EmptyState text="GitHub is not connected yet. Use the login page to reconnect and pull repo commits into the dashboard." compact />
                    <ActionLink href="/github-login">Open GitHub login page</ActionLink>
                  </div>
                )}
              </Panel>
            </div>
          </section>

          <section className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
            <Panel title="Captured AI events" subtitle="Raw detection records before they are correlated with commits.">
              {dashboard.captures.length === 0 ? (
                <EmptyState text="No proxy captures yet. Simulate an event or send real local proxy traffic." />
              ) : (
                <div className="space-y-3">
                  {dashboard.captures.map((capture) => (
                    <article key={capture.id} className="rounded-xl border border-[#252c3e] bg-[#11141c] p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap gap-2">
                            <MiniChip tone="grn">{capture.provider}</MiniChip>
                            <MiniChip tone="pur">{capture.model || "unknown model"}</MiniChip>
                            <MiniChip tone={capture.relatedToRepo ? "blu" : "amb"}>
                              {capture.relatedToRepo ? "repo-related" : "low confidence"}
                            </MiniChip>
                          </div>
                          <div className="mt-3 truncate font-mono text-sm text-[#edf0fa]">{capture.endpoint}</div>
                          <p className="mt-2 text-sm leading-6 text-[#8492b4]">{capture.excerpt}</p>
                        </div>
                        <div className="w-full rounded-xl border border-[#252c3e] bg-[#181d28] p-3 text-xs text-[#8492b4] md:w-[170px]">
                          <div className="font-medium text-[#edf0fa]">{capture.author.name}</div>
                          <div className="mt-1">{formatDateTime(capture.capturedAt)}</div>
                          <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.16em] text-[#4a5578]">Correlation</div>
                          <div className="mt-1 font-mono text-2xl font-bold text-[#edf0fa]">{capture.correlationScore}</div>
                        </div>
                      </div>
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <SubPanel title="Why it matched">
                          {capture.correlationReasons.map((reason) => (
                            <ListPill key={reason}>{reason}</ListPill>
                          ))}
                        </SubPanel>
                        <SubPanel title="Vulnerability hints">
                          {capture.vulnerabilities.map((finding) => (
                            <ListPill key={`${finding.severity}-${finding.title}`}>
                              <span className={`mr-2 inline-block rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${severityClass(finding.severity)}`}>
                                {finding.severity}
                              </span>
                              {finding.title}
                            </ListPill>
                          ))}
                        </SubPanel>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </Panel>

            <div className="grid gap-4">
              <Panel title="Analysis summary" subtitle="Fast telemetry for the current repo view.">
                <MetricRow label="AI-related captures" value={String(dashboard.analytics.aiAssistedCommits)} />
                <MetricRow label="Critical findings" value={String(countSeverity(dashboard.analytics.vulnerabilities, "critical"))} />
                <MetricRow label="High findings" value={String(countSeverity(dashboard.analytics.vulnerabilities, "high"))} />
                <MetricRow label="Medium findings" value={String(countSeverity(dashboard.analytics.vulnerabilities, "medium"))} />
              </Panel>

              <Panel title="Contributors" subtitle="Activity grouped by detected author.">
                {dashboard.analytics.contributors.length === 0 ? (
                  <EmptyState text="No contributors detected yet." compact />
                ) : (
                  dashboard.analytics.contributors.map((contributor) => (
                    <div key={contributor.login} className="flex items-center gap-3 rounded-xl border border-[#252c3e] bg-[#11141c] px-4 py-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-full border border-[#313a54] bg-[#1f2535] font-mono text-xs font-semibold text-[#4d8eff]">
                        {initials(contributor.name)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-[#edf0fa]">{contributor.name}</div>
                        <div className="mt-1 text-xs text-[#8492b4]">
                          {contributor.events} events | {contributor.relatedEvents} repo-related
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </Panel>

              <Panel title="Limits" subtitle="Known constraints in the current local architecture.">
                <div className="space-y-2">
                  {dashboard.analytics.unsupportedCapabilities.map((item) => (
                    <div key={item} className="rounded-xl border border-[#403117] bg-[#2a1a00] px-4 py-3 text-sm text-[#f5a623]">
                      {item}
                    </div>
                  ))}
                </div>
              </Panel>

              {latestCapture ? (
                <Panel title="Next step" subtitle="What finishes the loop from detection to proof.">
                  <p className="text-sm leading-6 text-[#8492b4]">
                    Your local proxy should post captures to <code className="rounded bg-[#181d28] px-1.5 py-0.5 text-[#edf0fa]">/api/proxy/events</code>.
                    Commit receipts are now retained per hash, so every analyzed commit can keep its own AI percentage in the feed instead of only the latest one.
                  </p>
                </Panel>
              ) : null}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function GithubLoginPage({ repoName, github, githubMessage, connecting, onConnect, onDisconnect }) {
  const connected = Boolean(github?.connected);

  return (
    <main className="min-h-screen bg-[#0b0d12] text-[#edf0fa]">
      <TopBar repoName={repoName} connectedLabel={connected ? github.user?.login || "connected" : "not connected"} githubConnected={connected} />

      <div className="mx-auto flex min-h-[calc(100vh-52px)] max-w-6xl items-center px-4 py-8 md:px-6">
        <div className="grid w-full gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <section className="rounded-3xl border border-[#252c3e] bg-[#11141c] p-6 shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
            <div className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#4a5578]">GitHub Access</div>
            <h1 className="mt-3 font-mono text-3xl font-bold tracking-tight text-[#edf0fa] md:text-4xl">
              Connect GitHub before you sync commit history.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-[#8492b4]">
              This page keeps the OAuth flow separate from the dashboard so reconnecting is simpler and the callback can return to one stable place.
            </p>

            {githubMessage ? (
              <div className="mt-5 rounded-xl border border-[#313a54] bg-[#181d28] px-4 py-3 text-sm text-[#c7d1eb]">
                {githubMessage}
              </div>
            ) : null}

            <div className="mt-6 flex flex-wrap gap-3">
              <ActionButton onClick={onConnect} disabled={connecting} active>
                {connecting ? "Connecting..." : connected ? "Reconnect GitHub" : "Connect GitHub"}
              </ActionButton>
              {connected ? <ActionButton onClick={onDisconnect}>Disconnect</ActionButton> : null}
              <ActionLink href="/">Back to dashboard</ActionLink>
            </div>

            <div className="mt-6 grid gap-3 md:grid-cols-3">
              <StatCard
                label="Status"
                value={connected ? "Connected" : "Offline"}
                sub={connected ? github.user?.login || "linked" : "oauth required"}
                tone={connected ? "text-[#1fc86b]" : "text-[#f5a623]"}
              />
              <StatCard
                label="Scope"
                value="repo"
                sub="read:user user:email repo"
                tone="text-[#4d8eff]"
              />
              <StatCard
                label="Callback"
                value="local"
                sub="handled by backend"
                tone="text-[#c7d1eb]"
              />
            </div>
          </section>

          <div className="grid gap-4">
            <Panel title="Connection status" subtitle="Current OAuth state from the backend.">
              <MetricRow label="Connected" value={connected ? "yes" : "no"} />
              <MetricRow label="Login" value={github?.user?.login ?? "--"} />
              <MetricRow label="Name" value={github?.user?.name ?? "--"} />
              <MetricRow label="Connected at" value={formatDateTime(github?.connectedAt)} />
              <MetricRow label="Profile" value={github?.user?.profileUrl ?? "not linked"} />
            </Panel>

            <Panel title="What this unlocks" subtitle="Why the dashboard asks for GitHub access.">
              <ListPill>Loads recent repository commits into the dashboard feed.</ListPill>
              <ListPill>Keeps commit metadata aligned with local AI receipts.</ListPill>
              <ListPill>Lets the app show linked profile details instead of local-only mode.</ListPill>
            </Panel>

            <Panel title="Troubleshooting" subtitle="If GitHub refuses the callback again.">
              <ListPill>The backend now avoids sending an explicit <code className="rounded bg-[#11141c] px-1.5 py-0.5 text-[#edf0fa]">redirect_uri</code> unless explicitly enabled.</ListPill>
              <ListPill>Restart the backend once so the updated OAuth logic is picked up.</ListPill>
              <ListPill>If the GitHub app still rejects login, its registered callback in GitHub settings needs to match the local backend callback.</ListPill>
            </Panel>
          </div>
        </div>
      </div>
    </main>
  );
}

function TopBar({ repoName, connectedLabel, githubConnected }) {
  return (
    <header className="sticky top-0 z-20 flex h-[52px] items-center gap-4 border-b border-[#252c3e] bg-[#11141c] px-4 md:px-6">
      <div className="flex items-center gap-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[#1fc86b] font-mono text-[11px] font-bold text-[#0b0d12]">
          CC
        </div>
        <div>
          <div className="font-mono text-sm font-bold text-[#edf0fa]">Commit Confessional</div>
          <div className="font-mono text-[10px] text-[#4a5578]">{repoName}</div>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-3">
        <MiniChip tone={githubConnected ? "grn" : "amb"}>{connectedLabel}</MiniChip>
        <MiniChip tone="gry">realtime dashboard</MiniChip>
      </div>
    </header>
  );
}

function SidebarSection({ title, children }) {
  return (
    <section className="mb-4">
      <div className="px-2 pb-1 font-mono text-[9px] uppercase tracking-[0.18em] text-[#4a5578]">{title}</div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

function SidebarItem({ children, active = false }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-sm transition ${
        active
          ? "border-[#313a54] bg-[#0d1e3d] text-[#edf0fa]"
          : "border-transparent bg-transparent text-[#8492b4] hover:border-[#252c3e] hover:bg-[#181d28]"
      }`}
    >
      {children}
    </div>
  );
}

function SidebarMetric({ label, value }) {
  return (
    <div className="rounded-lg border border-[#252c3e] bg-[#181d28] px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-[#4a5578]">{label}</div>
      <div className="mt-1 font-mono text-sm font-bold text-[#edf0fa]">{value}</div>
    </div>
  );
}

function ActionButton({ children, active = false, ...props }) {
  return (
    <button
      {...props}
      className={`rounded-lg border px-4 py-2 font-mono text-[11px] transition disabled:opacity-60 ${
        active
          ? "border-[#1fc86b]/30 bg-[#0d2e1c] text-[#1fc86b] hover:border-[#1fc86b]/50"
          : "border-[#313a54] bg-[#1f2535] text-[#c7d1eb] hover:border-[#4d8eff]/30 hover:text-[#edf0fa]"
      }`}
    />
  );
}

function ActionLink({ children, href }) {
  return (
    <a
      href={href}
      className="inline-flex rounded-lg border border-[#313a54] bg-[#1f2535] px-4 py-2 font-mono text-[11px] text-[#c7d1eb] transition hover:border-[#4d8eff]/30 hover:text-[#edf0fa]"
    >
      {children}
    </a>
  );
}

function HighlightCard({ label, value, detailTop, detailBottom, accent }) {
  return (
    <div className="rounded-xl border border-[#252c3e] bg-[#181d28] p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#4a5578]">{label}</div>
      <div className={`mt-2 font-mono text-3xl font-bold ${accent}`}>{value}</div>
      <div className="mt-3 text-sm text-[#edf0fa]">{detailTop}</div>
      <div className="mt-1 text-xs text-[#8492b4]">{detailBottom}</div>
    </div>
  );
}

function StatCard({ label, value, sub, tone }) {
  return (
    <div className="rounded-xl border border-[#252c3e] bg-[#11141c] p-4">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#4a5578]">{label}</div>
      <div className={`mt-2 font-mono text-[28px] font-bold leading-none ${tone}`}>{value}</div>
      <div className="mt-2 text-xs text-[#8492b4]">{sub}</div>
    </div>
  );
}

function Panel({ title, subtitle, children }) {
  return (
    <section className="rounded-2xl border border-[#252c3e] bg-[#11141c] p-5">
      <div className="mb-4">
        <div className="font-mono text-sm font-bold text-[#edf0fa]">{title}</div>
        {subtitle ? <div className="mt-1 text-xs text-[#8492b4]">{subtitle}</div> : null}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function SubPanel({ title, children }) {
  return (
    <div>
      <div className="mb-2 font-mono text-[10px] uppercase tracking-[0.18em] text-[#4a5578]">{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function MetricRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-[#252c3e] bg-[#181d28] px-4 py-3">
      <span className="text-sm text-[#8492b4]">{label}</span>
      <span className="font-mono text-sm font-semibold text-[#edf0fa]">{value}</span>
    </div>
  );
}

function EmptyState({ text, compact = false }) {
  return (
    <div className={`rounded-xl border border-dashed border-[#313a54] bg-[#181d28] text-[#8492b4] ${compact ? "px-4 py-3 text-sm" : "px-5 py-8 text-sm"}`}>
      {text}
    </div>
  );
}

function MiniChip({ children, tone = "gry" }) {
  return <span className={`inline-flex rounded-full px-2.5 py-1 font-mono text-[10px] ${chipClass(tone)}`}>{children}</span>;
}

function ListPill({ children }) {
  return <div className="rounded-lg border border-[#252c3e] bg-[#181d28] px-3 py-2 text-sm text-[#c7d1eb]">{children}</div>;
}

function CellValue({ value, tone }) {
  return <div className={`font-mono text-sm font-bold ${tone}`}>{value}</div>;
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

function countSeverity(items, severity) {
  return items.find((item) => item.severity === severity)?.count || 0;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("");
}

function severityClass(severity) {
  if (severity === "critical") return "bg-[#2a0e18] text-[#ff4060]";
  if (severity === "high") return "bg-[#2a1a00] text-[#f5a623]";
  if (severity === "medium") return "bg-[#0d1e3d] text-[#4d8eff]";
  return "bg-[#1f2535] text-[#8492b4]";
}

function scoreTone(score) {
  if (score >= 80) return "text-[#1fc86b]";
  if (score >= 50) return "text-[#f5a623]";
  return "text-[#ff4060]";
}

function certaintyTone(certainty) {
  if (certainty === "CERTAIN") return "text-[#1fc86b]";
  if (certainty === "HIGH") return "text-[#4d8eff]";
  if (certainty === "PROBABLE") return "text-[#f5a623]";
  return "text-[#8492b4]";
}

function chipTone(certainty) {
  if (certainty === "CERTAIN") return "grn";
  if (certainty === "HIGH") return "blu";
  if (certainty === "PROBABLE") return "amb";
  return "gry";
}

function chipClass(tone) {
  if (tone === "grn") return "border border-[#1fc86b]/20 bg-[#0d2e1c] text-[#1fc86b]";
  if (tone === "red") return "border border-[#ff4060]/20 bg-[#2a0e18] text-[#ff4060]";
  if (tone === "amb") return "border border-[#f5a623]/20 bg-[#2a1a00] text-[#f5a623]";
  if (tone === "blu") return "border border-[#4d8eff]/20 bg-[#0d1e3d] text-[#4d8eff]";
  if (tone === "pur") return "border border-[#9b72ff]/20 bg-[#1a1035] text-[#9b72ff]";
  return "border border-[#252c3e] bg-[#1f2535] text-[#8492b4]";
}
