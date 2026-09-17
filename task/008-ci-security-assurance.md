# Task 008: Add CI and adversarial security assurance

Status: Proposed  
Priority: P1  
Severity: Medium  
Area: Quality engineering  
Dependencies: Tasks 001 through 007

## Problem

README says CI runs lint, typecheck, test, and build, but no workflow is tracked in the repository. The current 37 tests cover core happy paths and several important rejections, but they do not cover the four confirmed boundary bypasses or cross-platform path/executable behavior comprehensively.

## Scope

- Add GitHub Actions for supported Node versions and Windows, Ubuntu, and macOS.
- Run npm ci, format check, lint, typecheck, tests, build, and production dependency audit.
- Add dependency-review, secret-scanning, and CodeQL or an equivalent TypeScript static analysis job.
- Add coverage reporting with meaningful per-module thresholds, especially for security policies.
- Add property/fuzz tests for paths, patch headers, command policy, redaction, and output truncation.
- Keep fixtures synthetic; never place real credentials in tests or logs.

## Acceptance criteria

- Every pull request exercises all supported operating-system path semantics.
- The confirmed PoCs from this review exist as regression tests and fail on the old implementation.
- Security-policy modules have branch coverage targets, not only line coverage.
- CI permissions are least-privilege and third-party actions are pinned to immutable commit SHAs.
- Dependency audit behavior is documented so transient registry failures do not silently pass.

## Required test groups

- Sensitive path and search-engine parity.
- Trusted executable resolution and PATH/current-directory hijacking.
- Audit redaction and secure file creation.
- Capability-profile tool discovery.
- Patch parser limits and generated malformed inputs.
- Process lifecycle, output flood, and timeout cleanup.
