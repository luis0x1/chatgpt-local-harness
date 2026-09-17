# Task 007: Add runtime resource ceilings and complete execution auditing

Status: Proposed  
Priority: P1  
Severity: Medium  
Area: Process lifecycle and observability  
Dependencies: Tasks 004 and 005

## Problem

Timeout and captured-output bytes are bounded, but CPU, memory, process count, disk use, and network activity are not. After the output limit is reached, streams continue producing events until process exit or timeout.

Only successful ProcessManager returns are audited. Policy rejection, cwd rejection, spawn failure, and unexpected process-manager errors can leave no audit event, reducing incident visibility.

## Scope

- Stop or pause output streams once the limit is reached; optionally terminate a process that floods output.
- Add configurable process-count, memory, CPU, and file-size controls through the available OS/container mechanism.
- Make network access a separate capability when the host sandbox can enforce it.
- Record allowed, denied, failed-to-spawn, timed-out, output-limited, and normally completed attempts.
- Give each request a correlation ID and normalized outcome without logging raw secrets.
- Avoid killing a reused PID/process group after normal child exit; document the chosen descendant-cleanup strategy.

## Acceptance criteria

- Output flooding cannot consume unbounded CPU or memory in the harness.
- Every execution attempt produces exactly one terminal audit outcome.
- Policy denials and spawn failures are observable without leaking raw arguments.
- Timeout still terminates descendants on supported platforms.
- Unsupported resource controls fail closed in strict mode and are clearly reported otherwise.

## Required tests

- Infinite output, ignored SIGTERM, child tree, spawn ENOENT, policy denial, and cwd denial.
- Audit outcome count and correlation-ID assertions.
- Platform-specific descendant cleanup on Windows and POSIX.
- Stress test repeated short processes for handle, timer, and listener leaks.
