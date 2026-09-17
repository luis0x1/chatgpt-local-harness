# Task 001: Enforce sensitive-path policy on every file operation

Status: Completed  
Priority: P0  
Severity: High  
Area: File boundary

## Problem

FileTools.read checks only path.basename(relativePath). A direct request for .git/config or node_modules/pkg.js therefore bypasses the directory exclusions used by FileTools.list. The review PoC confirmed both reads succeed.

This contradicts the documented promise that file reading omits VCS, dependency, build-output, and credential paths. A repository remote URL can also contain credentials, making .git/config materially sensitive.

## Scope

- Introduce a shared path-classification policy that evaluates every relative path component, not only the basename.
- Apply it to file_read and the starting path of file_list.
- Keep entry filtering in recursive listing, but route it through the same policy.
- Protect at least .git, dependency/build directories, .env variants, private keys, credential files, and common local auth files such as .npmrc, .pypirc, .netrc, and auth.json.
- Make the protected set explicit and documented. Avoid silently expanding it to normal source files.
- Decide whether tracked example files such as .env.example are readable. If allowed, encode that as a narrow exception with tests.

## Acceptance criteria

- file_read rejects a protected file when any ancestor component is protected.
- file_list rejects a protected starting directory instead of listing its contents.
- Existing normal source reads and listings still work on Windows, Linux, and macOS paths.
- Symlinks cannot be used to enter a protected canonical target.
- README and SECURITY.md describe the exact policy without overstating it.

## Required tests

- Direct reads of .git/config, node_modules/pkg.js, dist/output.js, .env, nested .env.local, and representative credential files are rejected.
- Listing .git, node_modules, and a nested protected directory is rejected.
- .env.example behavior is intentional and tested.
- Mixed separators and case behavior are tested where the platform requires it.
- A normal filename containing a protected word, such as src/git-client.ts, remains readable.

## Implementation

Completed on 2026-09-17.

- Added a shared, component-aware sensitive-path policy for requested and canonical paths.
- Applied the policy to direct reads, listing roots, and recursive listing filters.
- Kept exactly `.env.example` readable as a terminal filename and documented the protected set.
- Added regression coverage for protected ancestors, listing roots, separator/case handling, canonical symlink targets, and normal filenames containing protected words.
