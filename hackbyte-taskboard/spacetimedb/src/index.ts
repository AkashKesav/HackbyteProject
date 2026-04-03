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
    }
  ),
});
export default spacetimedb;

const VALID_STATUSES = new Set(['todo', 'in_progress', 'done']);

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

function assertStatus(status: string): void {
  if (!VALID_STATUSES.has(status)) {
    throw new SenderError(`Invalid status '${status}'`);
  }
}

export const init = spacetimedb.init(ctx => {
  ctx.db.task.insert({
    id: 0n,
    title: 'Wire realtime reducer instrumentation',
    status: 'todo',
    source: 'auto',
    commitHash: undefined,
    context:
      'Agent inferred this from subscription and reducer activity in the current sprint branch.',
    createdAt: ctx.timestamp,
    authorIdentity: ctx.sender,
  });

  ctx.db.task.insert({
    id: 0n,
    title: 'Finalize deploy checklist for board release',
    status: 'in_progress',
    source: 'manual',
    commitHash: undefined,
    context: 'Manual planning item for the current release cut.',
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
    id: 0n,
    title: normalized,
    status: 'todo',
    source: 'manual',
    commitHash: undefined,
    context: 'Added manually from the board input.',
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
      id: 0n,
      title: normalized,
      status: 'todo',
      source: 'auto',
      commitHash,
      context,
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

    ctx.db.task.id.update({ ...task, context: context.trim() });
  }
);

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
      id: 0n,
      title: normalized,
      status: 'todo',
      source: 'auto',
      commitHash,
      context,
      createdAt: ctx.timestamp,
      authorIdentity: ctx.sender,
    });
  }
);
