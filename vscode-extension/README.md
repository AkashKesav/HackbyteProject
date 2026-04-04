# Hackbyte Code Narrator

This merged VS Code extension combines both previous editor integrations:

- Commit Confessional background detection for paste events, Copilot activity, and AI extension activation
- Living Codebase Narrator save-to-doc pipeline with a sidebar webview for live documentation

## Commands

- `Commit Confessional: Show Output`
- `Commit Confessional: Inspect AI Extensions`
- `Commit Confessional: List Matching AI Extensions`
- `Commit Confessional: Debug Status Report`
- `LCN: Ping Backend`
- `LCN: Show Output Log`

## Configuration

- `commitConfessional.*` controls background capture behavior
- `lcn.*` controls narrator backend, debounce, and ignored paths
