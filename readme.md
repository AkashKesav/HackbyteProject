## Introduction:Hackbyte:
first

## Real-Time Collaborative Task Board (React + SpacetimeDB)

This workspace now includes a reusable component at:

- src/components/CollaborativeTaskBoard.tsx

It ships with two exports:

- CollaborativeTaskBoard: Pure UI component that accepts tasks and callbacks.
- SpacetimeCollaborativeTaskBoard: Wrapper wired to SpacetimeDB React hooks.

### Install

```bash
npm add react react-dom tailwindcss spacetimedb
```

### Wire SpacetimeDB Provider

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { DbConnection, tables } from "./module_bindings";
import { SpacetimeCollaborativeTaskBoard } from "./src/components/CollaborativeTaskBoard";

const connectionBuilder = DbConnection.builder()
	.withUri("ws://localhost:3000")
	.withDatabaseName("MODULE_NAME")
	.withLightMode(true)
	.onConnect((conn) => {
		conn.subscriptionBuilder().subscribe([tables.task]);
	});

ReactDOM.createRoot(document.getElementById("root")!).render(
	<SpacetimeDBProvider connectionBuilder={connectionBuilder}>
		<SpacetimeCollaborativeTaskBoard
			tableName="task"
			reducers={{
				createTask: "createTask",
				advanceTaskStatus: "advanceTaskStatus",
			}}
			makeCreateTaskArgs={(title) => [title, "manual"]}
			makeAdvanceTaskArgs={(taskId, nextStatus) => [taskId, nextStatus]}
			commitUrlBuilder={(hash) => `https://github.com/your-org/your-repo/commit/${hash}`}
		/>
	</SpacetimeDBProvider>
);
```

### Expected Task Row Shape

The wrapper normalizes common field names from your task table:

- id / task_id / taskId
- title / task_title
- status (todo | in_progress | done)
- source (auto | manual)
- commit_hash / commitHash / linked_commit (optional)
- timestamp / created_at / createdAt
- context / reason / inferred_context
- author_identity / created_by / owner_identity

If your reducer signatures differ, use:

- makeCreateTaskArgs
- makeAdvanceTaskArgs

to map component actions to your module reducer inputs.