import { useEffect, useMemo, useRef, useState } from 'react';
import type { DocEntry, HealthResponse } from '@lcn/types';

const POLL_MS = 1500;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export function App() {
  const [docs, setDocs] = useState<DocEntry[]>([]);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [voteBusy, setVoteBusy] = useState<string | null>(null);
  const lastAudioPlayedFor = useRef<string | null>(null);

  async function vote(docId: string, direction: 'up' | 'down') {
    setVoteBusy(docId + direction);
    try {
      const res = await fetch(`/docs/${encodeURIComponent(docId)}/vote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ direction })
      });
      if (!res.ok) return;
      const out = (await res.json()) as { doc?: DocEntry };
      if (out.doc) {
        setDocs((prev) => prev.map((d) => (d.id === docId ? out.doc! : d)));
      }
    } finally {
      setVoteBusy(null);
    }
  }

  const latest = docs[0] ?? null;
  const title = useMemo(() => {
    if (!latest) return 'Waiting for saves...';
    return `${latest.filePath} - ${latest.summary}`;
  }, [latest]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const h = await fetchJson<HealthResponse>('/health');
        if (!cancelled) setHealth(h);
      } catch {
        // ignore
      }
      try {
        const out = await fetchJson<{ ok: boolean; docs: DocEntry[] }>('/docs?limit=50');
        if (!cancelled) setDocs(out.docs ?? []);
      } catch {
        // ignore
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    if (!latest) return;
    if (lastAudioPlayedFor.current === latest.id) return;
    lastAudioPlayedFor.current = latest.id;

    if (latest.audioUrl) {
      const audio = new Audio(latest.audioUrl);
      void audio.play().catch(() => {
        // autoplay may be blocked; ignore
      });
    }
  }, [latest]);

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <div className="brandTitle">Living Codebase Narrator</div>
          <div className="brandTagline">Capture intent at the moment of creation.</div>
        </div>
        <div className="status">
          <div className="pill">Backend: {health ? 'ok' : '...'}</div>
          <div className="pill">Gemini: {health?.integrations.gemini.configured ? 'on' : 'off'}</div>
          <div className="pill">HF: {health?.integrations.huggingface.configured ? 'on' : 'off'}</div>
          <div className="pill">ElevenLabs: {health?.integrations.elevenlabs.configured ? 'on' : 'off'}</div>
          <div className="pill">
            Mongo: {health?.integrations.mongodb.configured ? (health.integrations.mongodb.connected ? 'on' : 'down') : 'off'}
          </div>
          <div className="pill">Spacetime: {health?.integrations.spacetime.configured ? 'on' : 'off'}</div>
        </div>
      </header>

      <main className="grid">
        <section className="panel">
          <div className="panelTitle">Live feed</div>
          <div className="panelSubtitle">{title}</div>
          <div className="cards">
            {docs.map((d) => (
              <article key={d.id} className="card">
                <div className="cardHeader">
                  <div className="file">{d.filePath}</div>
                  <div className="meta">
                    <span className="chip">{d.language}</span>
                    <span className="chip">{new Date(d.createdAt).toLocaleTimeString()}</span>
                  </div>
                </div>
                <div className="summary">{d.summary}</div>
                <div className="cols">
                  <div>
                    <div className="colTitle">What changed</div>
                    <ul>
                      {d.whatChanged.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="colTitle">Why it matters</div>
                    <ul>
                      {d.whyItMatters.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="tags">
                  {d.tags.map((t) => (
                    <span className="tag" key={t}>
                      #{t}
                    </span>
                  ))}
                </div>
                {d.audioUrl ? (
                  <div className="audioRow">
                    <audio controls preload="none" src={d.audioUrl} />
                  </div>
                ) : (
                  <div className="audioRow">
                    <span className="chip">ElevenLabs audio unavailable</span>
                  </div>
                )}
                <div className="voteRow" style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="chip" style={{ fontSize: 11 }}>
                    votes {d.votes.up} / {d.votes.down}
                  </span>
                  <button
                    type="button"
                    className="chip"
                    disabled={voteBusy !== null}
                    onClick={() => void vote(d.id, 'up')}
                  >
                    Helpful
                  </button>
                  <button
                    type="button"
                    className="chip"
                    disabled={voteBusy !== null}
                    onClick={() => void vote(d.id, 'down')}
                  >
                    Not quite
                  </button>
                </div>
                <details className="diff">
                  <summary>Diff</summary>
                  <pre>{d.diff}</pre>
                </details>
              </article>
            ))}
            {docs.length === 0 ? <div className="empty">Save a file from the extension to see docs here.</div> : null}
          </div>
        </section>
      </main>
    </div>
  );
}
