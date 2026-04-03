import { SenderError, schema, table, t } from 'spacetimedb/server';

const spacetimedb = schema({
  task: table(
    {
      public: true,
      indexes: [
        { accessor: 'task_status', algorithm: 'btree', columns: ['status'] },
        { accessor: 'task_author_identity', algorithm: 'btree', columns: ['authorIdentity'] },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      title: t.string(),
      status: t.string(),
      source: t.string(),
      commitHash: t.string().optional(),
      context: t.string(),
      createdAt: t.timestamp(),
      authorIdentity: t.identity(),
      resolutionKind: t.string().default('unresolved'),
      resolutionSource: t.string().default('unresolved'),
      resolutionContext: t.string().default('Awaiting completion evidence.'),
      resolutionCommitHash: t.string().default('unlinked'),
      resolutionDocumentRefs: t.array(t.string()).default([]),
    }
  ),
  taskResolutionEvent: table(
    {
      name: 'task_resolution_event',
      public: true,
      indexes: [
        {
          accessor: 'task_resolution_event_task_id',
          algorithm: 'btree',
          columns: ['taskId'],
        },
      ],
    },
    {
      id: t.u64().primaryKey().autoInc(),
      taskId: t.u64(),
      taskTitle: t.string(),
      previousStatus: t.string(),
      newStatus: t.string(),
      aiResolved: t.bool(),
      reason: t.string(),
      resolutionSource: t.string(),
      commitHash: t.string().optional(),
      documentRefs: t.array(t.string()),
      createdAt: t.timestamp(),
      actorIdentity: t.identity(),
    }
  ),
});
export default spacetimedb;

const VALID_STATUSES = new Set(['todo', 'in_progress', 'done']);
const UNRESOLVED_KIND = 'unresolved';
const UNRESOLVED_SOURCE = 'unresolved';
const UNRESOLVED_CONTEXT = 'Awaiting completion evidence.';
const UNLINKED_COMMIT = 'unlinked';

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeTitle(title: string): string {
  return normalizeText(title);
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = normalizeText(value);
  return normalized || undefined;
}

function normalizeDocumentRefs(documentRefs: readonly string[]): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();

  for (const ref of documentRefs) {
    const normalized = normalizeText(ref);
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    refs.push(normalized);
  }

  return refs;
}

function assertStatus(status: string): void {
  if (!VALID_STATUSES.has(status)) {
    throw new SenderError(`Invalid status '${status}'`);
  }
}

function buildBaseTaskFields({
  title,
  status,
  source,
  context,
  commitHash,
}: {
  title: string;
  status: string;
  source: string;
  context: string;
  commitHash?: string;
}) {
  return {
    title,
    status,
    source,
    commitHash,
    context,
    resolutionKind: UNRESOLVED_KIND,
    resolutionSource: UNRESOLVED_SOURCE,
    resolutionContext: UNRESOLVED_CONTEXT,
    resolutionCommitHash: UNLINKED_COMMIT,
    resolutionDocumentRefs: [] as string[],
  };
}

function nextTaskId(ctx: any): bigint {
  let next = 1n;
  for (const task of ctx.db.task.iter()) {
    if (task.id >= next) {
      next = task.id + 1n;
    }
  }
  return next;
}

function nextTaskResolutionEventId(ctx: any): bigint {
  let next = 1n;
  for (const event of ctx.db.taskResolutionEvent.iter()) {
    if (event.id >= next) {
      next = event.id + 1n;
    }
  }
  return next;
}

function clearResolutionState<T extends {
  resolutionKind: string;
  resolutionSource?: string;
  resolutionContext?: string;
  resolutionCommitHash?: string;
  resolutionDocumentRefs: string[];
}>(task: T): T {
  return {
    ...task,
    resolutionKind: UNRESOLVED_KIND,
    resolutionSource: UNRESOLVED_SOURCE,
    resolutionContext: UNRESOLVED_CONTEXT,
    resolutionCommitHash: UNLINKED_COMMIT,
    resolutionDocumentRefs: [],
  };
}

function insertResolutionEvent(
  ctx: any,
  {
    taskId,
    taskTitle,
    previousStatus,
    newStatus,
    aiResolved,
    reason,
    resolutionSource,
    commitHash,
    documentRefs,
  }: {
    taskId: bigint;
    taskTitle: string;
    previousStatus: string;
    newStatus: string;
    aiResolved: boolean;
    reason: string;
    resolutionSource: string;
    commitHash?: string;
    documentRefs: string[];
  }
): void {
  ctx.db.taskResolutionEvent.insert({
    id: nextTaskResolutionEventId(ctx),
    taskId,
    taskTitle,
    previousStatus,
    newStatus,
    aiResolved,
    reason,
    resolutionSource,
    commitHash,
    documentRefs,
    createdAt: ctx.timestamp,
    actorIdentity: ctx.sender,
  });
}

export const init = spacetimedb.init(ctx => {
  ctx.db.task.insert({
    id: nextTaskId(ctx),
    ...buildBaseTaskFields({
      title: 'Wire realtime reducer instrumentation',
      status: 'todo',
      source: 'auto',
      context:
        'Agent inferred this from subscription and reducer activity in the current sprint branch.',
    }),
    createdAt: ctx.timestamp,
    authorIdentity: ctx.sender,
  });

  ctx.db.task.insert({
    id: nextTaskId(ctx),
    ...buildBaseTaskFields({
      title: 'Finalize deploy checklist for board release',
      status: 'in_progress',
      source: 'manual',
      context: 'Manual planning item for the current release cut.',
    }),
    createdAt: ctx.timestamp,
    authorIdentity: ctx.sender,
  });
});

export const onConnect = spacetimedb.clientConnected(_ctx => {
  // Reducer kept for lifecycle visibility; no-op for now.
});

export const onDisconnect = spacetimedb.clientDisconnected(_ctx => {
  // Reducer kept for lifecycle visibility; no-op for now.
});

export const createTask = spacetimedb.reducer({ title: t.string() }, (ctx, { title }) => {
  const normalized = normalizeTitle(title);
  if (!normalized) {
    throw new SenderError('Task title is required.');
  }

  ctx.db.task.insert({
    id: nextTaskId(ctx),
    ...buildBaseTaskFields({
      title: normalized,
      status: 'todo',
      source: 'manual',
      context: 'Added manually from the board input.',
    }),
    createdAt: ctx.timestamp,
    authorIdentity: ctx.sender,
  });
});

export const createAutoTask = spacetimedb.reducer(
  {
    title: t.string(),
    context: t.string(),
    commitHash: t.string().optional(),
  },
  (ctx, { title, context, commitHash }) => {
    const normalized = normalizeTitle(title);
    if (!normalized) {
      throw new SenderError('Task title is required.');
    }

    ctx.db.task.insert({
      id: nextTaskId(ctx),
      ...buildBaseTaskFields({
        title: normalized,
        status: 'todo',
        source: 'auto',
        commitHash: normalizeOptionalText(commitHash),
        context: normalizeText(context),
      }),
      createdAt: ctx.timestamp,
      authorIdentity: ctx.sender,
    });
  }
);

export const advanceTaskStatus = spacetimedb.reducer(
  { id: t.u64(), nextStatus: t.string() },
  (ctx, { id, nextStatus }) => {
    assertStatus(nextStatus);

    const task = ctx.db.task.id.find(id);
    if (!task) {
      throw new SenderError('Task not found.');
    }

    if (task.status === nextStatus) {
      return;
    }

    if (nextStatus === 'done') {
      const updatedTask = {
        ...task,
        status: 'done',
        resolutionKind: 'manual',
        resolutionSource: 'manual_status_cycle',
        resolutionContext: 'Task marked done manually from the board.',
        resolutionCommitHash: task.commitHash ?? UNLINKED_COMMIT,
        resolutionDocumentRefs: [] as string[],
      };

      ctx.db.task.id.update(updatedTask);
      insertResolutionEvent(ctx, {
        taskId: task.id,
        taskTitle: task.title,
        previousStatus: task.status,
        newStatus: 'done',
        aiResolved: false,
        reason: 'Task marked done manually from the board.',
        resolutionSource: 'manual_status_cycle',
        commitHash: task.commitHash,
        documentRefs: [],
      });
      return;
    }

    if (task.status === 'done') {
      const reopenedTask = {
        ...clearResolutionState(task),
        status: nextStatus,
      };

      ctx.db.task.id.update(reopenedTask);
      insertResolutionEvent(ctx, {
        taskId: task.id,
        taskTitle: task.title,
        previousStatus: task.status,
        newStatus: nextStatus,
        aiResolved: false,
        reason: `Task moved from done back to ${nextStatus}.`,
        resolutionSource: 'manual_reopen',
        commitHash: task.resolutionCommitHash ?? task.commitHash,
        documentRefs: task.resolutionDocumentRefs,
      });
      return;
    }

    ctx.db.task.id.update({ ...task, status: nextStatus });
  }
);

export const updateTaskContext = spacetimedb.reducer(
  { id: t.u64(), context: t.string() },
  (ctx, { id, context }) => {
    const task = ctx.db.task.id.find(id);
    if (!task) {
      throw new SenderError('Task not found.');
    }

    const normalized = normalizeText(context);
    if (!normalized) {
      throw new SenderError('Task context is required.');
    }

    ctx.db.task.id.update({ ...task, context: normalized });
  }
);

export const deleteTask = spacetimedb.reducer({ id: t.u64() }, (ctx, { id }) => {
  const task = ctx.db.task.id.find(id);
  if (!task) {
    throw new SenderError('Task not found.');
  }

  ctx.db.taskResolutionEvent.task_resolution_event_task_id.delete(task.id);
  ctx.db.task.id.delete(task.id);
});

export const seedAutoTask = spacetimedb.reducer(
  {
    title: t.string(),
    context: t.string(),
    commitHash: t.string().optional(),
  },
  (ctx, { title, context, commitHash }) => {
    const normalized = normalizeTitle(title);
    if (!normalized) {
      throw new SenderError('Task title is required.');
    }

    ctx.db.task.insert({
      id: nextTaskId(ctx),
      ...buildBaseTaskFields({
        title: normalized,
        status: 'todo',
        source: 'auto',
        commitHash: normalizeOptionalText(commitHash),
        context: normalizeText(context),
      }),
      createdAt: ctx.timestamp,
      authorIdentity: ctx.sender,
    });
  }
);

export const resolveTaskFromInference = spacetimedb.reducer(
  {
    id: t.u64(),
    reason: t.string(),
    resolutionSource: t.string(),
    commitHash: t.string().optional(),
    documentRefs: t.array(t.string()),
  },
  (ctx, { id, reason, resolutionSource, commitHash, documentRefs }) => {
    const task = ctx.db.task.id.find(id);
    if (!task) {
      throw new SenderError('Task not found.');
    }

    if (task.status === 'done') {
      throw new SenderError('Task is already resolved.');
    }

    const normalizedReason = normalizeText(reason);
    if (!normalizedReason) {
      throw new SenderError('Resolution reason is required.');
    }

    const normalizedResolutionSource =
      normalizeOptionalText(resolutionSource) ?? 'gemini_commit_doc_match';
    const normalizedCommitHash = normalizeOptionalText(commitHash);
    const normalizedDocumentRefs = normalizeDocumentRefs(documentRefs);

    const resolvedTask = {
      ...task,
      status: 'done',
      commitHash: normalizedCommitHash ?? task.commitHash,
      resolutionKind: 'ai',
      resolutionSource: normalizedResolutionSource,
      resolutionContext: normalizedReason,
      resolutionCommitHash: normalizedCommitHash ?? task.commitHash ?? UNLINKED_COMMIT,
      resolutionDocumentRefs: normalizedDocumentRefs,
    };

    ctx.db.task.id.update(resolvedTask);
    insertResolutionEvent(ctx, {
      taskId: task.id,
      taskTitle: task.title,
      previousStatus: task.status,
      newStatus: 'done',
      aiResolved: true,
      reason: normalizedReason,
      resolutionSource: normalizedResolutionSource,
      commitHash: normalizedCommitHash,
      documentRefs: normalizedDocumentRefs,
    });
  }
);
