# Local Harness review backlog

Review date: 2026-09-17

## Outcome

The project has a clear security model, small modules, strict TypeScript, bounded file/output reads, path canonicalization, a sanitized child environment, timeout-based process-tree cleanup, and useful security documentation. The current baseline passes lint, typecheck, 37 tests, build, and a production dependency audit with zero reported vulnerabilities.

The review also confirmed four concrete boundary weaknesses with a disposable local fixture:

- Direct file reads can enter hidden/ignored directories such as .git and node_modules.
- A caller-supplied ripgrep glob can re-include .env after the built-in exclusion.
- Audit redaction misses common sk-prefixed tokens and Bearer credentials.
- Allowlisted executable names are resolved through PATH and can select an attacker-controlled binary.

The unrestricted execution surface is a documented architectural risk rather than an accidental bug: node, Python, package managers, and shell_exec can execute repository-controlled code with all permissions of the harness OS user. It should still be made opt-in and represented accurately to clients.

## Baseline verification

| Check                       | Result                               |
| --------------------------- | ------------------------------------ |
| npm run lint                | Passed                               |
| npm run typecheck           | Passed                               |
| npm test                    | Passed: 7 files, 37 tests            |
| npm run build               | Passed                               |
| npm audit --omit=dev --json | Passed: 0 production vulnerabilities |

## Task order

| ID  | Priority | Kind                       | Summary                                                            | Depends on |
| --- | -------- | -------------------------- | ------------------------------------------------------------------ | ---------- |
| 001 | P0       | Confirmed security issue   | Enforce one sensitive-path policy for direct reads and listings    | None       |
| 002 | P0       | Confirmed security issue   | Make search exclusions non-overridable and align fallback behavior | 001        |
| 003 | P0       | Confirmed security issue   | Resolve and pin trusted executable paths                           | None       |
| 004 | P0       | Confirmed security issue   | Harden audit-log storage and secret redaction                      | None       |
| 005 | P1       | Architectural hardening    | Add execution capability profiles and accurate annotations         | 003        |
| 006 | P1       | Defensive hardening        | Bound and fully validate patch input                               | 001        |
| 007 | P1       | Availability/observability | Add runtime resource ceilings and audit failed attempts            | 004, 005   |
| 008 | P1       | Assurance                  | Add CI, adversarial tests, and fuzz/property testing               | 001-007    |
| 009 | P2       | Product improvement        | Add context-efficient repository inspection tools                  | 001, 002   |

P0 means fix before treating the harness as a strong protection boundary. P1 should follow before wider or multi-user deployment. P2 improves efficiency and correctness but is not a release blocker.

## Suggested milestones

1. Boundary integrity: tasks 001-004.
2. Safer execution: tasks 005-007.
3. Continuous assurance: task 008.
4. Agent efficiency: task 009.

Each task includes acceptance criteria and regression tests so it can be implemented independently. No production behavior was changed by this review.
