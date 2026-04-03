import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";

export type TaskStatus = "todo" | "in_progress" | "done";
export type TaskSource = "auto" | "manual";

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  source: TaskSource;
  commitHash?: string | null;
  timestamp: string;
  context: string;
  authorIdentity?: string;
}

export interface CollaborativeTaskBoardProps {
  tasks: TaskItem[];
  onCreateTask: (title: string) => Promise<void> | void;
  onAdvanceTaskStatus: (taskId: string, nextStatus: TaskStatus) => Promise<void> | void;
  localIdentity?: string;
  className?: string;
  commitUrlBuilder?: (hash: string) => string;
}

const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "done"];

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  done: "Done",
};

const STATUS_BADGE_STYLES: Record<TaskStatus, string> = {
  todo: "border-amber-500/50 bg-amber-500/10 text-amber-300",
  in_progress: "border-sky-500/50 bg-sky-500/10 text-sky-300",
  done: "border-emerald-500/50 bg-emerald-500/10 text-emerald-300",
};

const EMPTY_STATE_COPY: Record<TaskStatus, { tag: string; body: string }> = {
  todo: {
    tag: "queue.idle()",
    body: "No queued work. Drop a task to seed the next agent execution pass.",
  },
  in_progress: {
    tag: "runtime.waiting()",
    body: "No active thread. Promote a task when someone starts implementation.",
  },
  done: {
    tag: "release.log.empty()",
    body: "No shipped slices yet. Completed tasks and commit links land here.",
  },
};

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function cycleStatusForward(status: TaskStatus): TaskStatus {
  const currentIndex = STATUS_ORDER.indexOf(status);
  const nextIndex = currentIndex === STATUS_ORDER.length - 1 ? 0 : currentIndex + 1;
  return STATUS_ORDER[nextIndex];
}

function buildClassName(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function CollaborativeTaskBoard({
  tasks,
  onCreateTask,
  onAdvanceTaskStatus,
  localIdentity,
  className,
  commitUrlBuilder,
}: CollaborativeTaskBoardProps) {
  const [draftTitle, setDraftTitle] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [isCreatingTask, setIsCreatingTask] = useState(false);
  const [advancingTaskId, setAdvancingTaskId] = useState<string | null>(null);
  const [arrivingTaskIds, setArrivingTaskIds] = useState<Set<string>>(new Set());

  const previousTaskIdsRef = useRef<Set<string>>(new Set());
  const didInitializeTaskSnapshotRef = useRef(false);
  const arrivalTimeoutsRef = useRef<number[]>([]);

  const columns = useMemo(() => {
    const grouped: Record<TaskStatus, TaskItem[]> = {
      todo: [],
      in_progress: [],
      done: [],
    };

    for (const task of tasks) {
      grouped[task.status].push(task);
    }

    for (const key of STATUS_ORDER) {
      grouped[key].sort((a, b) => {
        const first = new Date(a.timestamp).getTime();
        const second = new Date(b.timestamp).getTime();
        return second - first;
      });
    }

    return grouped;
  }, [tasks]);

  useEffect(() => {
    return () => {
      for (const timeoutId of arrivalTimeoutsRef.current) {
        window.clearTimeout(timeoutId);
      }
    };
  }, []);

  useEffect(() => {
    const knownIds = previousTaskIdsRef.current;

    if (!didInitializeTaskSnapshotRef.current) {
      previousTaskIdsRef.current = new Set(tasks.map((task) => task.id));
      didInitializeTaskSnapshotRef.current = true;
      return;
    }

    const justInserted = tasks.filter((task) => !knownIds.has(task.id));

    previousTaskIdsRef.current = new Set(tasks.map((task) => task.id));

    if (justInserted.length === 0 || typeof window === "undefined") {
      return;
    }

    const teammateTaskIds = justInserted
      .filter((task) => {
        if (!task.authorIdentity) {
          return false;
        }

        return localIdentity ? task.authorIdentity !== localIdentity : true;
      })
      .map((task) => task.id);

    if (teammateTaskIds.length === 0) {
      return;
    }

    setArrivingTaskIds((current) => {
      const next = new Set(current);
      for (const id of teammateTaskIds) {
        next.add(id);
      }
      return next;
    });

    const timeoutId = window.setTimeout(() => {
      setArrivingTaskIds((current) => {
        const next = new Set(current);
        for (const id of teammateTaskIds) {
          next.delete(id);
        }
        return next;
      });
    }, 420);

    arrivalTimeoutsRef.current.push(timeoutId);
  }, [tasks, localIdentity]);

  const submitTask = useCallback(async () => {
    const nextTitle = draftTitle.trim();
    if (!nextTitle || isCreatingTask) {
      return;
    }

    setIsCreatingTask(true);
    try {
      await onCreateTask(nextTitle);
      setDraftTitle("");
    } finally {
      setIsCreatingTask(false);
    }
  }, [draftTitle, isCreatingTask, onCreateTask]);

  const advanceStatus = useCallback(
    async (task: TaskItem) => {
      if (advancingTaskId) {
        return;
      }

      setAdvancingTaskId(task.id);
      try {
        await onAdvanceTaskStatus(task.id, cycleStatusForward(task.status));
      } finally {
        setAdvancingTaskId(null);
      }
    },
    [advancingTaskId, onAdvanceTaskStatus]
  );

  return (
    <section
      className={buildClassName(
        "w-full rounded-md border border-zinc-800 bg-[#0a0a0a] p-3 text-zinc-100",
        "shadow-[0_0_0_1px_rgba(255,255,255,0.02)_inset]",
        className
      )}
    >
      <style>{`
        @keyframes teammateTaskIn {
          0% {
            opacity: 0;
            transform: translateY(6px);
          }
          100% {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>

      <div className="mb-3">
        <input
          aria-label="Add manual task"
          className={buildClassName(
            "h-10 w-full rounded-md border border-zinc-800 bg-[#0d0d0d] px-3",
            "text-sm text-zinc-200 placeholder:text-zinc-600",
            "focus:border-zinc-500 focus:outline-none",
            isCreatingTask ? "cursor-not-allowed opacity-60" : undefined
          )}
          disabled={isCreatingTask}
          onChange={(event) => setDraftTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") {
              return;
            }

            event.preventDefault();
            void submitTask();
          }}
          placeholder="Type manual task and press Enter"
          value={draftTitle}
        />
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {STATUS_ORDER.map((status) => {
          const columnTasks = columns[status];
          const emptyState = EMPTY_STATE_COPY[status];

          return (
            <section
              className="flex min-h-[340px] flex-col rounded-md border border-zinc-800 bg-[#0d0d0d] p-2"
              key={status}
            >
              <header className="mb-2 flex items-center justify-between border-b border-zinc-800 pb-2">
                <h3
                  className="text-[13px] font-semibold uppercase tracking-[0.1em] text-zinc-100"
                  style={{ fontFamily: "Space Grotesk, Sora, ui-sans-serif" }}
                >
                  {STATUS_LABELS[status]}
                </h3>
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                  {columnTasks.length.toString().padStart(2, "0")}
                </span>
              </header>

              <div className="flex flex-1 flex-col gap-2">
                {columnTasks.length === 0 ? (
                  <div className="flex flex-1 flex-col justify-center rounded-md border border-dashed border-zinc-800 bg-[#0b0b0b] p-3">
                    <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                      {emptyState.tag}
                    </p>
                    <p className="mt-2 text-[12px] leading-5 text-zinc-400">{emptyState.body}</p>
                  </div>
                ) : (
                  columnTasks.map((task) => {
                    const isExpanded = expandedTaskId === task.id;
                    const isArriving = arrivingTaskIds.has(task.id);
                    const isAuto = task.source === "auto";
                    const cardStyle: React.CSSProperties = {};

                    if (isAuto) {
                      cardStyle.backgroundImage =
                        "repeating-linear-gradient(0deg, rgba(255,255,255,0.02), rgba(255,255,255,0.02) 1px, transparent 1px, transparent 4px)";
                    }

                    if (isArriving) {
                      cardStyle.animation = "teammateTaskIn 220ms ease-out";
                    }

                    const commitHref =
                      task.commitHash && commitUrlBuilder
                        ? commitUrlBuilder(task.commitHash)
                        : undefined;

                    return (
                      <article
                        className={buildClassName(
                          "cursor-pointer rounded-md border border-zinc-800 bg-[#101010] p-2",
                          "transition-colors hover:bg-[#141414]",
                          isAuto ? "border-dashed" : undefined
                        )}
                        key={task.id}
                        onClick={() => {
                          setExpandedTaskId((current) => (current === task.id ? null : task.id));
                        }}
                        style={cardStyle}
                      >
                        <div className="mb-2 flex items-start justify-between gap-2">
                          <p className="text-[13px] leading-5 text-zinc-100">{task.title}</p>
                          <button
                            className={buildClassName(
                              "shrink-0 rounded border px-2 py-1 font-mono text-[10px] uppercase",
                              "tracking-[0.14em] transition-opacity",
                              STATUS_BADGE_STYLES[task.status],
                              advancingTaskId === task.id ? "cursor-wait opacity-70" : "hover:opacity-80"
                            )}
                            disabled={advancingTaskId === task.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              void advanceStatus(task);
                            }}
                            type="button"
                          >
                            {STATUS_LABELS[task.status]}
                          </button>
                        </div>

                        <div className="mb-2 flex flex-wrap gap-1">
                          <span className="border border-zinc-600 px-1 py-[1px] font-mono text-[9px] uppercase tracking-[0.16em] text-zinc-300">
                            {task.source}
                          </span>
                          {isAuto ? (
                            <span className="border border-zinc-500 px-1 py-[1px] font-mono text-[9px] uppercase tracking-[0.2em] text-zinc-200">
                              ai
                            </span>
                          ) : null}
                        </div>

                        <div className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.12em] text-zinc-500">
                          <span>{formatTimestamp(task.timestamp)}</span>
                          {task.commitHash ? (
                            commitHref ? (
                              <a
                                className="hover:text-zinc-300"
                                href={commitHref}
                                onClick={(event) => event.stopPropagation()}
                                rel="noreferrer"
                                target="_blank"
                              >
                                {task.commitHash.slice(0, 8)}
                              </a>
                            ) : (
                              <span>{task.commitHash.slice(0, 8)}</span>
                            )
                          ) : null}
                        </div>

                        {isExpanded ? (
                          <div className="mt-2 border-t border-zinc-800 pt-2">
                            <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500">
                              inferred context
                            </p>
                            <p className="mt-1 text-[12px] leading-5 text-zinc-300">
                              {task.context || "No inferred reason attached yet."}
                            </p>
                          </div>
                        ) : null}
                      </article>
                    );
                  })
                )}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}

type UnknownTaskRecord = Record<string, unknown>;

interface SpacetimeConnectionLike {
  reducers?: Record<string, (...args: unknown[]) => unknown>;
  identity?: { toHexString?: () => string } | string;
}

export interface SpacetimeTaskBoardProps {
  tableName?: string;
  reducers?: {
    createTask: string;
    advanceTaskStatus: string;
  };
  makeCreateTaskArgs?: (title: string) => unknown[];
  makeAdvanceTaskArgs?: (taskId: string, nextStatus: TaskStatus) => unknown[];
  localIdentity?: string;
  className?: string;
  commitUrlBuilder?: (hash: string) => string;
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }

  return undefined;
}

function normalizeStatus(value: unknown): TaskStatus {
  const candidate = coerceString(value)?.toLowerCase().replace(/[\s-]+/g, "_");

  if (candidate === "todo" || candidate === "in_progress" || candidate === "done") {
    return candidate;
  }

  if (candidate === "inprogress" || candidate === "working") {
    return "in_progress";
  }

  return "todo";
}

function normalizeSource(value: unknown): TaskSource {
  const candidate = coerceString(value)?.toLowerCase();
  return candidate === "auto" || candidate === "ai" ? "auto" : "manual";
}

function normalizeTimestamp(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return new Date().toISOString();
}

function normalizeTaskRow(row: UnknownTaskRecord, index: number): TaskItem {
  const title = coerceString(row.title) ?? coerceString(row.task_title) ?? "Untitled task";
  const timestamp = normalizeTimestamp(
    row.timestamp ?? row.created_at ?? row.createdAt ?? row.inserted_at
  );

  return {
    id:
      coerceString(row.id) ??
      coerceString(row.task_id) ??
      coerceString(row.taskId) ??
      `${title}:${timestamp}:${index}`,
    title,
    status: normalizeStatus(row.status),
    source: normalizeSource(row.source ?? row.origin ?? row.task_source),
    commitHash:
      coerceString(row.commit_hash) ?? coerceString(row.commitHash) ?? coerceString(row.linked_commit),
    timestamp,
    context:
      coerceString(row.context) ??
      coerceString(row.reason) ??
      coerceString(row.inferred_context) ??
      "",
    authorIdentity:
      coerceString(row.author_identity) ??
      coerceString(row.created_by) ??
      coerceString(row.owner_identity),
  };
}

export function SpacetimeCollaborativeTaskBoard({
  tableName = "task",
  reducers = {
    createTask: "createTask",
    advanceTaskStatus: "advanceTaskStatus",
  },
  makeCreateTaskArgs = (title: string) => [title],
  makeAdvanceTaskArgs = (taskId: string, nextStatus: TaskStatus) => [taskId, nextStatus],
  localIdentity,
  className,
  commitUrlBuilder,
}: SpacetimeTaskBoardProps) {
  const connection = useSpacetimeDB<SpacetimeConnectionLike>();
  const table = useTable<SpacetimeConnectionLike, UnknownTaskRecord>(tableName);

  const tasks = useMemo(() => {
    const rows = Array.isArray(table.rows) ? table.rows : [];
    return rows.map((row, index) => normalizeTaskRow(row, index));
  }, [table.rows]);

  const resolvedIdentity = useMemo(() => {
    if (localIdentity) {
      return localIdentity;
    }

    if (typeof connection.identity === "string") {
      return connection.identity;
    }

    if (typeof connection.identity?.toHexString === "function") {
      return connection.identity.toHexString();
    }

    return undefined;
  }, [connection.identity, localIdentity]);

  const runReducer = useCallback(
    async (reducerName: string, args: unknown[]) => {
      const reducer = connection.reducers?.[reducerName];
      if (typeof reducer !== "function") {
        console.warn(`[task-board] reducer not found: ${reducerName}`);
        return;
      }

      await Promise.resolve(reducer(...args));
    },
    [connection.reducers]
  );

  const createTask = useCallback(
    async (title: string) => {
      await runReducer(reducers.createTask, makeCreateTaskArgs(title));
    },
    [makeCreateTaskArgs, reducers.createTask, runReducer]
  );

  const advanceTask = useCallback(
    async (taskId: string, nextStatus: TaskStatus) => {
      await runReducer(reducers.advanceTaskStatus, makeAdvanceTaskArgs(taskId, nextStatus));
    },
    [makeAdvanceTaskArgs, reducers.advanceTaskStatus, runReducer]
  );

  return (
    <CollaborativeTaskBoard
      className={className}
      commitUrlBuilder={commitUrlBuilder}
      localIdentity={resolvedIdentity}
      onAdvanceTaskStatus={advanceTask}
      onCreateTask={createTask}
      tasks={tasks}
    />
  );
}
