# Security

## Security model

The harness assumes repository files, patches, tool arguments, and process output are hostile. Model instructions are guidance only; workspace, command, environment, timeout, output, and path policies are enforced by server code.

The server is intended to run as a low-privilege local user, ideally in a disposable VM, container, or WSL distribution. A denylist is not a sandbox and cannot make arbitrary shell execution safe.

## Trust boundaries

- ChatGPT Work reaches the local stdio process through Secure MCP Tunnel; the project does not open a public listening port.
- `workspace_open` canonicalizes a requested directory and accepts it only below an explicitly configured root.
- Subsequent workspace tools use an opaque workspace ID. Relative paths are canonicalized again, and symlinks that escape the workspace are rejected.
- Optional local memory uses a separate non-overlapping canonical root and exposes only read-only search, get, and list operations. If the root is under `~/.codex`, only `~/.codex/memories` is accepted.
- Child processes receive a small environment allowlist, not a copy of `process.env`.
- Output and runtime are bounded. Timeout handling terminates the process tree on Unix and Windows.
- `command_exec` uses `spawn` with `shell: false`. `shell_exec` invokes a platform shell explicitly and is annotated destructive/open-world.

## Protected data

Secret-shaped environment keys are never forwarded, even if accidentally added to the configured allowlist. This includes OpenAI/control-plane keys, cloud-provider variables, GitHub/NPM tokens, SSH agent sockets, database URLs, and names ending in `_SECRET`, `_TOKEN`, or `_PASSWORD`.

Workspace file listing and reading omit common `.env`, private-key, credential, dependency, VCS, and build-output paths by default. Memory tools only expose allowlisted text extensions, exclude hidden entries and project scopes from global reads, bound results/output, and redact common token, API-key, password, URL-credential, JWT, and private-key forms. Audit records store metadata and a redacted/truncated command, not file contents or child environments.

## Command policy

The policy blocks known high-risk patterns: broad recursive deletion, shutdown/format commands, privilege escalation, destructive Git cleanup/history rewrites, force pushes, remote branch/tag deletion, package publishing, and common credential/private-key access. The policy is deliberately conservative but is not a complete shell parser or sandbox.

`shell_exec` can still modify files, launch processes, and access the network. Keep a human approval boundary around its use and explain each command before invocation.

## Residual risks

- An allowed compiler, package manager, test runner, or script can execute repository-controlled code.
- A malicious dependency can use the current OS user's permissions, including network access permitted by the host.
- Race-free filesystem confinement requires OS-level sandboxing; the server narrows race windows but cannot eliminate every TOCTOU class on all platforms.
- Command deny patterns may miss encoded, indirect, or novel destructive behavior.
- Output limits and pattern-based memory redaction reduce exfiltration volume but cannot recognize every secret format or encoded value.
- Memory files are untrusted input and may be stale, incorrect, or malicious; they must not override tool policy or current source verification.
- Memory tools are read-only, but arbitrary build or shell processes still inherit the OS user's filesystem permissions. Use OS/container permissions when the memory directory must be immutable to those processes.

For stronger isolation, run the harness in a container/VM with a read/write mount only for approved repositories, no host credentials, limited networking, resource limits, and a non-root user.

## Reporting

Open a private security advisory in the GitHub repository. Do not include real credentials, private repository contents, or exploit payloads containing secrets.
