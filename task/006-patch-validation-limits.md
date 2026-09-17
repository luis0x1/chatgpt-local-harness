# Task 006: Bound and fully validate patch input

Status: Proposed  
Priority: P1  
Severity: Medium  
Area: Patch application  
Dependency: Task 001

## Problem

The apply_patch schema has no maximum patch length, file count, or hunk count. PatchTool validates paths found in the old/new headers but does not establish a complete parsed model of every diff operation before invoking git apply.

This creates denial-of-service risk and makes future support for rename, copy, mode changes, binary patches, and unusual headers easy to get wrong.

## Scope

- Add configurable hard limits for patch bytes, files, hunks, and per-line length.
- Parse and validate each diff record as a coherent unit.
- Reject binary patches, submodules/gitlinks, symlinks, rename/copy metadata, mode-only changes, and unsupported quoted paths unless intentionally implemented.
- Apply the shared protected-path policy from task 001.
- Require every path used by git apply to appear in the validated model.
- Preserve the per-workspace lock and concurrent fingerprint check.
- Consider applying through a temporary index or other transaction-like mechanism to reduce partial-application risk.

## Acceptance criteria

- Oversized or structurally ambiguous patches fail before git is spawned.
- All created, modified, and deleted paths are validated and counted.
- Protected paths and special Git object types are rejected.
- A failed patch leaves the worktree unchanged.
- Error messages identify the unsupported feature without echoing sensitive patch content.

## Required tests

- Boundary tests for byte, file, hunk, and line limits.
- New/delete/modify cases plus rejected rename, copy, binary, symlink, gitlink, and mode-only patches.
- Mismatched diff/header paths and duplicate headers.
- Concurrent modification and partial-failure regression tests.
- Property tests over generated headers and path separators.
