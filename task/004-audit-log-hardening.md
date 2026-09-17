# Task 004: Harden audit-log storage and redaction

Status: Proposed  
Priority: P0  
Severity: High  
Area: Audit and secrets

## Problem

The default audit path is a predictable filename in the shared OS temporary directory. appendFile follows an existing symlink, and the mode option does not repair permissions on a pre-existing file. Another local user or process may be able to redirect writes or cause command metadata to land in an unexpectedly readable file.

AuditLog also imports the small environment-policy redactor instead of the stronger memory redactor. The review PoC confirmed that representative sk-prefixed and Bearer credentials remain unchanged.

## Scope

- Use a private per-user runtime/state directory with owner-only permissions, or securely create a unique log file.
- Open with append/create semantics that reject symlinks where the platform supports it.
- Verify that an existing target is a regular owner-controlled file and enforce restrictive permissions.
- Consolidate secret redaction into one implementation shared by audit and memory.
- Redact Bearer values, URL credentials, JWTs, private keys, common provider tokens, and secret-like key/value pairs.
- Prefer logging an executable name plus a hash/summary of arguments instead of full arguments. Make full command logging an explicit opt-in.
- Define rotation and maximum retained size.

## Acceptance criteria

- The default path cannot be redirected through a pre-created symlink.
- Existing permissive or non-regular targets fail closed.
- No test token appears in plaintext in audit output.
- Audit writes remain serialized and each record is valid JSONL.
- Log size and retention are bounded.

## Required tests

- Symlink, FIFO/non-regular file, permissive existing file, and concurrent-write cases.
- A table of fake token formats, Bearer headers, URL credentials, JWTs, private keys, and quoted/unquoted secrets.
- UTF-8 and truncation behavior after redaction.
- Windows and POSIX permission behavior, with explicitly documented limitations.
