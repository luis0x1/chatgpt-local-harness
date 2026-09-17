# Task 005: Add explicit execution capability profiles

Status: Proposed  
Priority: P1  
Severity: High architectural risk  
Area: Tool exposure  
Dependency: Task 003

## Problem

The command denylist is not a sandbox. Default allowlisted interpreters and package managers can read or modify files outside the workspace, access the network, and execute repository-controlled code. shell_exec is even broader.

This risk is documented, but both tools are registered by default. command_exec is marked destructiveHint false even though node, Python, Git, and package scripts can perform destructive changes. Client approval behavior may therefore be weaker than the actual capability warrants.

## Scope

- Add explicit profiles, for example inspect, build, and unrestricted.
- In inspect mode, do not register command_exec or shell_exec.
- In build mode, expose a narrow configured command set and keep shell_exec disabled.
- Require an explicit startup flag for unrestricted shell access.
- Mark command_exec destructive unless it is replaced by narrower tools whose behavior is genuinely non-destructive.
- Consider dedicated test/build/lint tools with fixed argv templates instead of a general interpreter.
- Surface the active profile and enabled capabilities in server instructions and a read-only capability-info tool.
- Keep OS/container sandbox guidance, but do not present the denylist as confinement.

## Acceptance criteria

- A fresh installation starts in the least-capable useful profile.
- shell_exec cannot be invoked unless explicitly enabled.
- Tool annotations accurately represent write, destructive, and open-world behavior.
- Configuration errors fail closed and explain which flag is required.
- README includes recommended profiles for trusted repos and hostile repos.

## Required tests

- Tool discovery snapshots for every profile.
- Attempts to call disabled tools fail because they are not registered.
- Annotation tests cover command_exec as well as shell_exec.
- Configuration parsing rejects contradictory or unknown capability values.
