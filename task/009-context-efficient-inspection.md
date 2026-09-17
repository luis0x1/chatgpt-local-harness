# Task 009: Add context-efficient repository inspection tools

Status: Proposed  
Priority: P2  
Kind: Product improvement  
Area: Agent efficiency  
Dependencies: Tasks 001 and 002

## Problem

The bundled skill tells the agent to start with repo_map and prefer range/symbol reads, but the server exposes neither repo_map, file_read_range, file_outline, nor symbol_read. The fallback instruction works, yet file_read still returns the whole file and large repositories spend unnecessary tokens and I/O.

## Scope

- Add file_stat with size, mtime, and content hash.
- Add file_read_range with line bounds, total-line metadata, hash, and truncation status.
- Add repo_map with bounded directory and language-aware symbol summaries.
- Add file_outline and symbol_read, initially for TypeScript/JavaScript and extensible through tree-sitter or language servers.
- Add workspace_changes based on a caller-held snapshot/hash rather than server-side hidden state.
- Ensure every new tool reuses the sensitive-path and output-limit policies.
- Update the skill so it references only tools actually exposed by the active server version.

## Acceptance criteria

- Agents can locate and read one relevant function without fetching the entire file.
- Responses include enough hash/range metadata to detect stale context.
- All outputs have depth, entry, byte, and time limits.
- Unsupported languages degrade to a bounded text outline without pretending semantic accuracy.
- Tool annotations and documentation match actual behavior.

## Required tests

- UTF-8, CRLF/LF, empty files, very long lines, and out-of-range requests.
- Hash changes after edits and unchanged responses with a known hash.
- Symbol extraction for nested and overloaded declarations.
- Protected paths remain inaccessible through every new inspection tool.
- Large synthetic repository tests demonstrate bounded output and improved payload size.
