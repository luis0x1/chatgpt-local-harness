# Repository agent instructions

Workspace: `/home/luis/myspace/chatgpt-local-harness`

Before working in this repository, read and follow `skills/local-coding/SKILL.md`.

## Tool responsibilities

- Use Code Review Graph to explore architecture, symbols, dependencies, callers and callees, related tests, execution flows, and blast radius.
- Treat Code Review Graph output as directional data only. Always verify the current code with Local Harness before drawing conclusions or making changes.
- Use only Local Harness to read exact source, perform additional searches, edit files, run commands, build, test, inspect Git status, and inspect Git diffs.
- Before a multi-file or architectural change, use Code Review Graph to determine the affected scope.
- When Code Review Graph is accessed through the local harness integration, call `workspace_open` first and pass the returned `workspaceId`; the harness must resolve the repository path server-side rather than accepting an arbitrary `repo_root` from the client.
- After editing, run tests with Local Harness, update the graph, and use Code Review Graph to re-check affected flows and test gaps.
- For a small one-file change whose location and impact are already clear, Code Review Graph may be skipped.
- Never use Code Review Graph as a substitute for reading the real source.
- Do not use any filesystem tool other than Local Harness for this repository.

If Local Harness or Code Review Graph is unavailable for a required step, stop and report the blocker instead of switching to another filesystem tool.
