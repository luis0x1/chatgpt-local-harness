# Task 002: Make repository search exclusions non-overridable

Status: Completed  
Priority: P0  
Severity: High  
Area: Search boundary  
Dependency: Task 001

## Problem

SearchTool appends the caller glob after built-in negative globs. Ripgrep uses later matching overrides, so a positive glob such as .env can re-include a file that the harness excluded earlier. The review PoC confirmed an .env match is returned.

When ripgrep is unavailable, the fallback ignores the glob argument entirely. The two engines therefore expose different data and do not honor the same request contract.

## Scope

- Apply the shared sensitive-path policy from task 001 independently of user filters.
- Treat the caller glob only as an additional narrowing filter; it must never widen the protected set.
- Prefer enumerating approved files first and passing them to the search engine, or validate/filter every returned match before it leaves the server.
- Implement the same glob semantics in the fallback, using a maintained matcher rather than an ad hoc partial parser.
- Return a clear validation error for unsupported or unsafe patterns.
- Add an engine field as today, but guarantee equivalent security semantics for both engines.

## Acceptance criteria

- No caller glob can re-include .env, private keys, VCS metadata, dependency directories, or other protected paths.
- Ripgrep and fallback return the same eligible path set for the same query and glob.
- cwd is still canonicalized and confined to the workspace.
- Search limits remain enforced after filtering.

## Required tests

- Reproduce the positive-glob override against .env and prove it is blocked.
- Cover broad globs, negated globs, brace patterns, hidden files, and nested protected paths.
- Force fallback mode and run the same table-driven cases.
- Verify a normal narrowing glob such as src/**/*.ts works in both engines.
- Test a symlink swap or document the remaining TOCTOU limitation if it cannot be eliminated portably.

## Implementation

Completed on 2026-09-17.

- Enumerated candidates through `FileTools.list` before either search engine runs.
- Applied one validated Minimatch glob to the approved candidate set; caller patterns are never forwarded to ripgrep.
- Batched only approved paths into ripgrep and made both engines use literal-query semantics, the same relative output paths, and one combined output limit.
- Revalidated fallback reads through `FileTools.read`.
- Added table-driven coverage for rg and forced fallback modes, including positive override attempts, broad/negated/brace globs, hidden files, protected descendants, validation, and truncation.
- Documented the remaining ripgrep TOCTOU window in README and SECURITY.md.
