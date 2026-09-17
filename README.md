# Local Coding Harness for ChatGPT Work

A local, stdio MCP server that lets ChatGPT Work inspect, search, patch, diff, build, lint, and test code inside explicitly allowed workspace roots, with an optional read-only local memory boundary. Secure MCP Tunnel connects the local process without exposing a public port.

## Requirements

- Node.js 20 or newer
- Git and (recommended) ripgrep (`rg`)
- A ChatGPT Work workspace with Developer mode and Secure MCP Tunnel access
- Windows PowerShell, or a POSIX shell on Linux/macOS

## Install and build

```powershell
git clone https://github.com/luis0x1/chatgpt-local-harness.git
cd chatgpt-local-harness
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Configure roots explicitly. JSON is recommended because it works with Windows drive letters:

```powershell
$env:LOCAL_HARNESS_ROOTS = '["C:\\Users\\you\\source","D:\\work"]'
$env:LOCAL_HARNESS_MEMORY_ROOT = "C:\Users\you\.codex\memories"
$env:LOCAL_HARNESS_ENV_ALLOWLIST = "CI,NO_COLOR"
```

On Linux/macOS:

```bash
export LOCAL_HARNESS_ROOTS='["/home/you/source","/work"]'
export LOCAL_HARNESS_MEMORY_ROOT='/home/you/.codex/memories'
export LOCAL_HARNESS_ENV_ALLOWLIST='CI,NO_COLOR'
```

The server intentionally has no default workspace root. It rejects filesystem roots, the user home directory, traversal, and symlink escapes. UNC paths are disabled unless `LOCAL_HARNESS_ALLOW_UNC=true` is set deliberately.

Start it over stdio:

```powershell
node .\dist\index.js
```

Do not expect a prompt: stdio is reserved for MCP JSON-RPC. Diagnostics go to stderr.

### Optional Google OAuth mode

Set `LOCAL_HARNESS_AUTH_ENABLED=true` to switch from stdio to a Streamable HTTP MCP endpoint at `/mcp`. The startup log prints `Authentication required: yes.` when this mode is active and `Authentication required: no.` otherwise.

OAuth mode requires a Google OAuth **Web application** client plus an explicit email whitelist:

```bash
export LOCAL_HARNESS_AUTH_ENABLED=true
export LOCAL_HARNESS_AUTH_WHITELIST='you@example.com,teammate@example.com'
export LOCAL_HARNESS_GOOGLE_CLIENT_ID='...'
export LOCAL_HARNESS_GOOGLE_CLIENT_SECRET='...'
export LOCAL_HARNESS_AUTH_BASE_URL='http://127.0.0.1:3000'
export LOCAL_HARNESS_HTTP_HOST='127.0.0.1'
export LOCAL_HARNESS_HTTP_PORT='3000'
node dist/index.js
```

Register `${LOCAL_HARNESS_AUTH_BASE_URL}/oauth/google/callback` as an authorized redirect URI in the Google OAuth client. For a remote/tunneled deployment, set `LOCAL_HARNESS_AUTH_BASE_URL` to the externally reachable HTTPS origin instead of the loopback default. Plain HTTP is accepted only for loopback development.

For ChatGPT's **User-Defined OAuth Client** mode, pre-register one client in the harness:

```bash
export LOCAL_HARNESS_OAUTH_CLIENT_ID='chatgpt-local-harness'
export LOCAL_HARNESS_OAUTH_CLIENT_SECRET='replace-with-a-random-secret'
export LOCAL_HARNESS_OAUTH_REDIRECT_URIS='https://chatgpt.com/connector/oauth/REPLACE_WITH_CALLBACK_ID'
```

Use the exact Callback URL shown by ChatGPT for `LOCAL_HARNESS_OAUTH_REDIRECT_URIS`; the OAuth server rejects unregistered redirect URIs. Enter the same `LOCAL_HARNESS_OAUTH_CLIENT_ID` and `LOCAL_HARNESS_OAUTH_CLIENT_SECRET` in ChatGPT. When a secret is configured, choose `client_secret_post` as the token endpoint auth method. If no secret is configured, choose `none`.

The configured user-defined client coexists with Dynamic Client Registration. DCR remains available through `/register`; the static client is simply preloaded into the same client store so authorization and token requests can resolve its `client_id`.

The harness acts as the OAuth authorization server for MCP clients. Google is used only to verify the end user's identity. A verified Google email must exactly match the case-insensitive whitelist before the harness approves the authorization request. The harness then issues its own one-hour access token and rotating refresh token; Google access tokens are not returned to MCP clients.

OAuth client registrations, authorization state, access tokens, and refresh tokens are held in memory and are invalidated when the harness restarts. The `/mcp` endpoint requires a valid bearer token while OAuth discovery, registration, authorization, token, revocation, and Google callback endpoints remain reachable as required by the OAuth flow.

### Optional code-review-graph tools

The harness can spawn `code-review-graph` as an internal MCP stdio child and re-expose selected graph tools through the same parent MCP server. This means ChatGPT discovers the graph tools from the normal `/mcp` endpoint and, in HTTP mode, the existing OAuth bearer authentication protects them automatically.

```bash
export LOCAL_HARNESS_CODE_GRAPH_ENABLED=true
export LOCAL_HARNESS_CODE_GRAPH_COMMAND='code-review-graph'
```

The graph repository follows the workspace selected by the agent. Call `workspace_open` first and pass its returned `workspaceId` to each graph tool. The harness resolves that ID to the canonical workspace path and supplies it to `code-review-graph` as `repo_root`; MCP clients cannot provide an arbitrary repository path.

The exposed graph tools are `get_minimal_context_tool`, `get_impact_radius_tool`, `get_review_context_tool`, `query_graph_tool`, `detect_changes_tool`, `get_architecture_overview_tool`, and `list_graph_stats_tool`. Their names, descriptions, input shapes, and annotations are discovered from a child with `Client.listTools()` at startup. A graph child is then started lazily and cached per opened workspace, and calls are forwarded with `Client.callTool()` over `StdioClientTransport`.

The `code-review-graph` executable must be available on the harness process `PATH`, or set `LOCAL_HARNESS_CODE_GRAPH_COMMAND` to the executable path. If the child cannot start or tool discovery fails, harness startup fails instead of silently omitting the graph tools.

## Tools

| Tool             | Purpose                                             | Key annotation              |
| ---------------- | --------------------------------------------------- | --------------------------- |
| `workspace_open` | Canonicalize an allowed workspace and return its ID | read-only, closed-world     |
| `file_read`      | Read a bounded UTF-8 file                           | read-only, closed-world     |
| `file_list`      | Bounded recursive listing with secret/build ignores | read-only, closed-world     |
| `repo_search`    | Search approved files with `rg` or bounded fallback | read-only, closed-world     |
| `memory_search`  | Search bounded, redacted local-memory snippets      | read-only, closed-world     |
| `memory_get`     | Read one bounded, redacted memory file              | read-only, closed-world     |
| `memory_list`    | List allowlisted local-memory files                 | read-only, closed-world     |
| `apply_patch`    | Validate and apply a unified diff                   | write, non-destructive hint |
| `git_status`     | Read concise repository status                      | read-only, closed-world     |
| `git_diff`       | Read staged or unstaged diff                        | read-only, closed-world     |
| `command_exec`   | Spawn an allowlisted executable with `shell: false` | write-capable, open-world   |
| `shell_exec`     | Run pipes, redirects, and shell syntax              | **destructive, open-world** |

`command_exec` is the default execution tool. `shell_exec` can modify/delete files, launch processes, and access the network; explain the exact command and purpose before calling it.

## Workspace file visibility

`file_read` and `file_list` apply one case-insensitive policy to every component of both the requested path and its canonical target. Components may be separated by either `/` or `\\`. Exact protected directory names are `.git`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.svelte-kit`, and `target`.

The protected file names are `.env`, `.npmrc`, `.pypirc`, `.netrc`, `auth.json`, `credential`, `credentials`, `credential.json`, `credentials.json`, `id_rsa`, `id_ed25519`, `id_ecdsa`, and `id_dsa`. Files beginning with `.env.` and files ending in `.pem`, `.p12`, `.pfx`, or `.key` are also protected.

The sole `.env.*` exception is a terminal file named exactly `.env.example`; descendants below a directory with that name remain protected. Matching uses whole path components or documented suffixes, so normal source names such as `src/git-client.ts` and `src/build-helper.ts` remain visible. Recursive listings omit protected entries, while a protected starting path is rejected.

## Repository search semantics

`repo_search` treats `query` as a literal string in both engines. Before searching, it enumerates files through the same sensitive-path policy as `file_list`; the optional caller `glob` is then applied only as an additional narrowing filter. The caller glob is never passed to ripgrep and therefore cannot override protected-path exclusions.

Glob matching uses Minimatch against `/`-normalized paths relative to `cwd`. Broad globs, negation, brace expansion, basename patterns, and hidden non-sensitive files are supported. Patterns must be 1-1024 characters, relative, single-line, free of NUL bytes, and cannot contain parent traversal. Unsupported or unsafe patterns return a validation error.

Both engines receive the same bounded candidate list. Ripgrep searches those candidates in batches; the fallback reads the same candidates through `file_read` checks. Returned output remains bounded after filtering, and the result identifies `engine` as `rg` or `fallback`.

There is a residual TOCTOU window between candidate enumeration and ripgrep opening a file. A path swapped during that interval could be read with the harness OS user's permissions. The fallback revalidates every file at read time, but portable race-free confinement requires an OS sandbox.

## Configuration

| Variable                             | Default             | Meaning                                                            |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------ |
| `LOCAL_HARNESS_ROOTS`                | required            | JSON array (preferred) or platform-delimited allowed roots         |
| `LOCAL_HARNESS_MEMORY_ROOT`          | disabled            | Separate, existing, read-only local-memory root                    |
| `LOCAL_HARNESS_ALLOWED_COMMANDS`     | empty additions     | Comma-separated additions to the executable allowlist              |
| `LOCAL_HARNESS_ENV_ALLOWLIST`        | empty additions     | Explicit child environment keys; secret-shaped keys stay blocked   |
| `LOCAL_HARNESS_DEFAULT_TIMEOUT_MS`   | `120000`            | Default command timeout                                            |
| `LOCAL_HARNESS_MAX_TIMEOUT_MS`       | `300000`            | Maximum accepted timeout                                           |
| `LOCAL_HARNESS_MAX_OUTPUT_BYTES`     | `1048576`           | Combined stdout/stderr cap                                         |
| `LOCAL_HARNESS_MAX_FILE_BYTES`       | `1048576`           | File-read cap                                                      |
| `LOCAL_HARNESS_AUDIT_LOG`            | OS temp directory   | JSONL audit log path                                               |
| `LOCAL_HARNESS_ALLOW_UNC`            | `false`             | Allow intentionally configured UNC roots                           |
| `LOCAL_HARNESS_AUTH_ENABLED`         | `false`             | Enable Google OAuth and switch MCP transport from stdio to HTTP    |
| `LOCAL_HARNESS_AUTH_WHITELIST`       | empty               | Comma-separated Google email addresses allowed to authenticate     |
| `LOCAL_HARNESS_GOOGLE_CLIENT_ID`     | empty               | Google OAuth Web application client ID                             |
| `LOCAL_HARNESS_GOOGLE_CLIENT_SECRET` | empty               | Google OAuth Web application client secret                         |
| `LOCAL_HARNESS_OAUTH_CLIENT_ID`      | empty               | Pre-registered client ID for User-Defined OAuth Client mode        |
| `LOCAL_HARNESS_OAUTH_CLIENT_SECRET`  | empty               | Optional secret for the pre-registered OAuth client                |
| `LOCAL_HARNESS_OAUTH_REDIRECT_URIS`  | empty               | Comma-separated exact redirect URIs for the pre-registered client  |
| `LOCAL_HARNESS_AUTH_BASE_URL`        | loopback HTTP URL   | Public origin used for OAuth metadata and Google callback          |
| `LOCAL_HARNESS_HTTP_HOST`            | `127.0.0.1`         | Bind host used in OAuth/HTTP mode                                  |
| `LOCAL_HARNESS_HTTP_PORT`            | `3000`              | Bind port used in OAuth/HTTP mode                                  |
| `LOCAL_HARNESS_CODE_GRAPH_ENABLED`   | `false`             | Re-expose selected code-review-graph tools through this MCP server |
| `LOCAL_HARNESS_CODE_GRAPH_COMMAND`   | `code-review-graph` | Executable used for the internal MCP stdio child                   |

The child environment starts from a small portability allowlist. OpenAI/control-plane keys, `AWS_*`, `AZURE_*`, `GOOGLE_*`, GitHub/NPM tokens, `SSH_AUTH_SOCK`, `DATABASE_URL`, and keys ending in `_SECRET`, `_TOKEN`, or `_PASSWORD` are always removed.

## Local memory

Set `LOCAL_HARNESS_MEMORY_ROOT` to an existing absolute directory. It must not overlap any configured workspace root. If it is inside the Codex directory, the only accepted canonical location is `~/.codex/memories`; configuring `~/.codex` itself is rejected.

The read-only layout is:

```text
<memory-root>/
  decisions.md
  preferences.json
  projects/
    ramtray/
      setup.md
```

- Global scope reads files below the memory root but excludes `projects/`.
- Project scope reads `projects/<project>/`, where the project name is an explicit safe slug.
- Only `.md`, `.txt`, `.json`, `.yaml`, and `.yml` files are visible.
- Traversal, absolute tool paths, hidden entries, and symlink escapes are blocked.
- Search result count, scanned file size, individual reads, and returned payloads are bounded.
- Token-, API-key-, password-, authorization-, URL-credential-, JWT-, and private-key-shaped values are redacted before return.

Redaction is defense in depth, not a reason to store credentials in memory. Version 1 intentionally exposes no `memory_write` or `memory_delete` tool. Read-only here describes the MCP memory tool surface; OS-level isolation is still required because build tools and shell commands run with the harness user's permissions.

The local-coding skill calls `memory_search` only when the user refers to a prior decision, setup, preference, or earlier work. It searches before fetching a specific memory file to minimize context use.

## Inspect locally

After building and setting `LOCAL_HARNESS_ROOTS`, discover the tools with MCP Inspector:

```powershell
npx --yes @modelcontextprotocol/inspector node .\dist\index.js
```

Confirm all twelve tools appear, `shell_exec` is destructive/open-world, Git tools are read-only, and server instructions are present.

## Connect with Secure MCP Tunnel

1. Build the server as shown above.
2. Create a tunnel in the OpenAI Platform and copy its generated `tunnel_id`.
3. Never commit an API key. Set it only in the current PowerShell process:

```powershell
$env:CONTROL_PLANE_API_KEY = "..."
```

4. Initialize the tunnel using the local stdio server (replace paths and the generated ID):

```powershell
tunnel-client init `
  --sample sample_mcp_stdio_local `
  --profile local-harness `
  --tunnel-id tunnel_xxxxxxxxx `
  --mcp-command "node C:\path\to\project\dist\index.js"
```

5. Validate the profile:

```powershell
tunnel-client doctor --profile local-harness --explain
```

6. Run the tunnel:

```powershell
tunnel-client run --profile local-harness
```

7. In ChatGPT Work:
   - Enable **Developer mode**.
   - Open **Plugins** and select **+**.
   - Choose **Connection → Tunnel**.
   - Select or enter the generated `tunnel_id`.
   - Choose **Scan Tools**.
   - Verify tool annotations and server instructions before enabling the connection.

The plugin manifest intentionally contains no app/connection ID. GitHub cannot know the ID generated when you register the tunnel; keep it in the ChatGPT connection configuration rather than committing it. If your organization requires a manifest field for that ID, use an obvious local placeholder such as `REPLACE_WITH_GENERATED_CONNECTION_ID` and replace it only in private deployment configuration.

## Security notes

The command denylist is defense in depth, not a sandbox. Tests, builds, package managers, and allowed interpreters can execute repository-controlled code. Run the server as a non-admin/non-root user, preferably inside Docker, WSL, or a VM without host credentials. See [SECURITY.md](SECURITY.md) for the threat model and residual risks.

## Development

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

CI runs the same sequence with `npm ci` on Node.js 20.
