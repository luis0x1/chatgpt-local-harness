# Task 003: Resolve and pin trusted executable paths

Status: Proposed  
Priority: P0  
Severity: High  
Area: Process execution

## Problem

CommandPolicy allowlists executable basenames, while ProcessManager asks the OS to resolve those names through PATH. Internal operations such as git status, git apply, and rg search use the same mechanism.

The review PoC placed a fake git earlier in PATH and ProcessManager executed it. A writable PATH entry or platform-specific current-directory search can therefore turn a nominally trusted internal command into arbitrary code execution.

## Scope

- Resolve every built-in executable to a canonical absolute path during startup.
- Reject candidates in writable workspace paths and ambiguous duplicate resolutions.
- Store trusted paths in an immutable executable registry and pass only absolute paths to ProcessManager.
- Separate internal binaries, such as git and rg, from user-configured command_exec additions.
- Require configured additions to use absolute paths. Consider removing basename additions entirely.
- Validate ownership and writability where the platform exposes reliable metadata; document platform limitations.
- Revalidate or fail closed if a pinned binary is replaced after startup.

## Acceptance criteria

- Internal git, rg, and runtime calls never rely on cwd or PATH after startup.
- A fake executable in the workspace or an earlier PATH directory is not selected.
- Startup fails with an actionable error when a required executable is missing or ambiguous.
- Windows executable extensions and path casing are handled correctly.
- Documentation provides a safe migration path for LOCAL_HARNESS_ALLOWED_COMMANDS.

## Required tests

- Prepend a fake git, rg, node, and package-manager binary and confirm the trusted executable still runs.
- Replace or symlink-swap a configured binary after startup and confirm fail-closed behavior.
- Cover Windows PATHEXT and case-insensitive resolution.
- Confirm internal operations and command_exec use the registry rather than separate resolution logic.
