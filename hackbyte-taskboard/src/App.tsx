import type { CSSProperties, FormEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useReducer, useSpacetimeDB, useTable } from 'spacetimedb/react';
import { reducers, tables } from './module_bindings';
import type { Task as TaskRow } from './module_bindings/types';
import './app.css';

type TaskStatus = 'todo' | 'in_progress' | 'done';

const STATUS_ORDER: TaskStatus[] = ['todo', 'in_progress', 'done'];

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  done: 'Done',
};

const STATUS_BADGE_STYLES: Record<TaskStatus, string> = {
  todo: 'border-amber-400/60 bg-amber-500/10 text-amber-300',
  in_progress: 'border-sky-400/60 bg-sky-500/10 text-sky-300',
  done: 'border-emerald-400/60 bg-emerald-500/10 text-emerald-300',
};

const COLUMN_SIGNALS: Record<TaskStatus, string> = {
  todo: 'dispatch.queue',
  in_progress: 'worker.threads',
  done: 'release.output',
};

const EMPTY_STATE_COPY: Record<TaskStatus, { tag: string; body: string }> = {
  todo: {
    tag: 'queue.idle()',
    body: 'No tasks are staged for the next execution pass. Drop a manual item in to seed the queue.',
  },
  in_progress: {
    tag: 'workers.await()',
    body: 'Nothing is actively being implemented. Click a Todo badge when a teammate claims work.',
  },
  done: {
    tag: 'release.diff.zero()',
    body: 'No completed slices yet. Finished tasks and linked commits will accumulate in this lane.',
  },
};

function normalizeStatus(value: string): TaskStatus {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (normalized === 'in_progress' || normalized === 'done') {
    return normalized;
  }
  return 'todo';
}

function nextStatus(value: string): TaskStatus {
  const current = normalizeStatus(value);
  const index = STATUS_ORDER.indexOf(current);
  return STATUS_ORDER[index === STATUS_ORDER.length - 1 ? 0 : index + 1];
}

function identityHex(identity: unknown): string | undefined {
  if (!identity) {
    return undefined;
  }

  if (typeof identity === 'string') {
    return identity;
  }

  if (typeof identity === 'object' && identity !== null && 'toHexString' in identity) {
    const toHexString = (identity as { toHexString: () => string }).toHexString;
    return typeof toHexString === 'function' ? toHexString.call(identity) : undefined;
  }

  return undefined;
}

function getTimestampMicros(value: TaskRow['createdAt']): bigint | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (
    'microsSinceUnixEpoch' in value &&
    typeof (value as { microsSinceUnixEpoch?: unknown }).microsSinceUnixEpoch === 'bigint'
  ) {
    return (value as { microsSinceUnixEpoch: bigint }).microsSinceUnixEpoch;
  }

  if (
    '__timestamp_micros_since_unix_epoch__' in value &&
    typeof (value as { __timestamp_micros_since_unix_epoch__?: unknown }).__timestamp_micros_since_unix_epoch__ ===
      'bigint'
  ) {
    return (value as { __timestamp_micros_since_unix_epoch__: bigint }).__timestamp_micros_since_unix_epoch__;
  }

  return null;
}

function toDateLabel(value: TaskRow['createdAt']): string {
  const micros = getTimestampMicros(value);
  if (micros !== null) {
    const millis = Number(micros / 1000n);
    if (!Number.isNaN(millis)) {
      return new Date(millis).toLocaleString(undefined, {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }

  return 'timestamp.pending';
}

function taskSortTime(value: TaskRow['createdAt']): bigint {
  return getTimestampMicros(value) ?? 0n;
}

function App() {
  const conn = useSpacetimeDB();
  const [taskRows, tasksReady] = useTable(tables.task);

  const createTask = useReducer(reducers.createTask);
  const advanceTaskStatus = useReducer(reducers.advanceTaskStatus);

  const [draftTask, setDraftTask] = useState('');
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState(false);
  const [pendingAdvanceId, setPendingAdvanceId] = useState<string | null>(null);
  const [arrivingIds, setArrivingIds] = useState<Set<string>>(new Set());

  const firstSyncRef = useRef(false);
  const previousTaskIdsRef = useRef<Set<string>>(new Set());

  const connected = conn.isActive;
  const localIdentityHex = identityHex(conn.identity);

  const groupedTasks = useMemo(() => {
    const groups: Record<TaskStatus, TaskRow[]> = {
      todo: [],
      in_progress: [],
      done: [],
    };

    for (const task of taskRows) {
      groups[normalizeStatus(task.status)].push(task);
    }

    for (const status of STATUS_ORDER) {
      groups[status].sort((a, b) => {
        const first = taskSortTime(a.createdAt);
        const second = taskSortTime(b.createdAt);
        if (first === second) {
          if (b.id === a.id) {
            return 0;
          }
          return b.id > a.id ? 1 : -1;
        }
        return first > second ? -1 : 1;
      });
    }

    return groups;
  }, [taskRows]);

  useEffect(() => {
    if (!tasksReady) {
      return;
    }

    const currentIds = new Set(taskRows.map(task => task.id.toString()));

    if (!firstSyncRef.current) {
      previousTaskIdsRef.current = currentIds;
      firstSyncRef.current = true;
      return;
    }

    const inserted = taskRows.filter(task => !previousTaskIdsRef.current.has(task.id.toString()));
    previousTaskIdsRef.current = currentIds;

    if (inserted.length === 0) {
      return;
    }

    const teammateIds = inserted
      .filter(task => {
        const authorHex = identityHex(task.authorIdentity);
        return authorHex && authorHex !== localIdentityHex;
      })
      .map(task => task.id.toString());

    if (teammateIds.length === 0) {
      return;
    }

    setArrivingIds(prev => {
      const next = new Set(prev);
      for (const id of teammateIds) {
        next.add(id);
      }
      return next;
    });

    const timeout = window.setTimeout(() => {
      setArrivingIds(prev => {
        const next = new Set(prev);
        for (const id of teammateIds) {
          next.delete(id);
        }
        return next;
      });
    }, 420);

    return () => window.clearTimeout(timeout);
  }, [taskRows, tasksReady, localIdentityHex]);

  const onCreateTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!connected || pendingCreate) {
      return;
    }

    const title = draftTask.trim();
    if (!title) {
      return;
    }

    setPendingCreate(true);
    try {
      await createTask({ title });
      setDraftTask('');
    } finally {
      setPendingCreate(false);
    }
  };

  const onAdvanceTask = async (task: TaskRow) => {
    if (!connected || pendingAdvanceId) {
      return;
    }

    const next = nextStatus(task.status);
    setPendingAdvanceId(task.id.toString());
    try {
      await advanceTaskStatus({ id: task.id, nextStatus: next });
    } finally {
      setPendingAdvanceId(null);
    }
  };

  return (
    <main className="min-h-screen px-3 py-4 text-zinc-100 sm:px-5 sm:py-5 lg:px-8">
      <section className="mx-auto flex max-w-[1400px] flex-col gap-3">
        <header className="overflow-hidden rounded-md border border-zinc-800 bg-[#0d0d0d]/95 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="relative border-b border-zinc-800 px-4 py-4 sm:px-5">
            <div className="pointer-events-none absolute inset-y-0 right-0 w-72 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_58%)]" />
            <div className="relative flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <div className="space-y-2">
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
                  spacetime://forge-task-matrix
                </p>
                <div>
                  <h1 className="font-display text-[28px] font-semibold uppercase tracking-[0.04em] text-zinc-100 sm:text-[32px]">
                    Forge Task Matrix
                  </h1>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-zinc-400">
                    Real-time collaborative task routing for teammate and agent execution threads.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                <span className="rounded-sm border border-zinc-800 bg-black/30 px-2 py-1">
                  {connected ? 'link.up' : 'link.down'}
                </span>
                <span className="rounded-sm border border-zinc-800 bg-black/30 px-2 py-1">
                  {tasksReady ? 'subscription.applied' : 'subscription.syncing'}
                </span>
              </div>
            </div>
          </div>

          <form className="p-3 sm:p-4" onSubmit={onCreateTask}>
            <div className="rounded-md border border-zinc-800 bg-[#101010] p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                manual.enqueue()
              </p>
              <input
                aria-label="Add manual task"
                className="mt-2 h-11 w-full rounded-md border border-zinc-800 bg-[#0d0d0d] px-3 font-mono text-[13px] text-zinc-100 outline-none transition focus:border-zinc-500 placeholder:uppercase placeholder:tracking-[0.14em] placeholder:text-zinc-500 disabled:cursor-not-allowed disabled:opacity-55"
                disabled={!connected || pendingCreate}
                onChange={event => setDraftTask(event.target.value)}
                placeholder="Type a task and press Enter"
                value={draftTask}
              />
            </div>
          </form>
        </header>

        <section className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          {STATUS_ORDER.map(status => {
            const tasks = groupedTasks[status];
            const empty = EMPTY_STATE_COPY[status];

            return (
              <article
                className="flex min-h-[360px] flex-col rounded-md border border-zinc-800 bg-[#101010] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]"
                key={status}
              >
                <header className="border-b border-zinc-800 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">
                        {COLUMN_SIGNALS[status]}
                      </p>
                      <h2 className="font-display mt-1 text-[19px] font-semibold uppercase tracking-[0.08em] text-zinc-100">
                        {STATUS_LABELS[status]}
                      </h2>
                    </div>
                    <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                      {tasks.length.toString().padStart(2, '0')}
                    </span>
                  </div>
                </header>

                <div className="flex flex-1 flex-col gap-2 p-2.5">
                  {tasks.length === 0 ? (
                    <div className="flex min-h-[160px] flex-1 flex-col justify-center rounded-md border border-dashed border-zinc-800 bg-[#0b0b0b] px-3 py-4">
                      <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                        {empty.tag}
                      </p>
                      <p className="mt-2 text-sm leading-6 text-zinc-400">{empty.body}</p>
                    </div>
                  ) : (
                    tasks.map(task => {
                      const taskId = task.id.toString();
                      const isExpanded = expandedTaskId === taskId;
                      const isAuto = task.source === 'auto';
                      const isArriving = arrivingIds.has(taskId);
                      const normalizedStatus = normalizeStatus(task.status);
                      const cardStyle: CSSProperties = {};

                      if (isAuto) {
                        cardStyle.backgroundImage =
                          'repeating-linear-gradient(180deg, rgba(255,255,255,0.028), rgba(255,255,255,0.028) 1px, transparent 1px, transparent 4px)';
                      }

                      return (
                        <article
                          className={`cursor-pointer rounded-md border border-zinc-800 bg-[#121212] p-3 transition-colors duration-200 hover:border-zinc-700 hover:bg-[#161616] ${
                            isAuto ? 'border-dashed' : ''
                          } ${isArriving ? 'task-arriving' : ''}`}
                          key={taskId}
                          onClick={() => {
                            setExpandedTaskId(prev => (prev === taskId ? null : taskId));
                          }}
                          style={cardStyle}
                        >
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap gap-1.5">
                                <span className="rounded-sm border border-zinc-700 bg-black/25 px-1.5 py-[3px] font-mono text-[9px] uppercase tracking-[0.18em] text-zinc-400">
                                  {task.source}
                                </span>
                                {isAuto ? (
                                  <span className="rounded-sm border border-zinc-600 bg-zinc-950/80 px-1.5 py-[3px] font-mono text-[9px] uppercase tracking-[0.22em] text-zinc-200">
                                    AI
                                  </span>
                                ) : null}
                              </div>

                              <p className="mt-2 text-[14px] leading-5 text-zinc-100">{task.title}</p>
                            </div>

                            <button
                              className={`shrink-0 rounded-sm border px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] transition-opacity ${STATUS_BADGE_STYLES[normalizedStatus]} ${
                                pendingAdvanceId === taskId ? 'cursor-wait opacity-65' : 'hover:opacity-80'
                              }`}
                              disabled={pendingAdvanceId === taskId}
                              onClick={event => {
                                event.stopPropagation();
                                void onAdvanceTask(task);
                              }}
                              type="button"
                            >
                              {STATUS_LABELS[normalizedStatus]}
                            </button>
                          </div>

                          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                            <span>{toDateLabel(task.createdAt)}</span>
                            {task.commitHash ? <span>commit {task.commitHash.slice(0, 8)}</span> : null}
                          </div>

                          {isExpanded ? (
                            <div className="mt-3 border-t border-zinc-800 pt-3">
                              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                                {isAuto ? 'agent.inference' : 'task.context'}
                              </p>
                              <p className="mt-2 text-sm leading-6 text-zinc-300">
                                {task.context || 'No context attached yet.'}
                              </p>
                            </div>
                          ) : null}
                        </article>
                      );
                    })
                  )}
                </div>
              </article>
            );
          })}
        </section>
      </section>
    </main>
  );
}

export default App;
