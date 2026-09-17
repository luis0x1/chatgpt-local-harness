import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { OutputLimiter } from "./output-limiter.js";

export interface ProcessRequest {
  executable: string;
  args?: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
  shell?: boolean | string;
  stdin?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cwd: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

async function taskkill(pid: number): Promise<void> {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  });
  await once(killer, "close").catch(() => undefined);
}

async function terminateTree(pid: number, force: boolean): Promise<void> {
  if (process.platform === "win32") {
    await taskkill(pid);
    return;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH") throw error;
  }
}

export class ProcessManager {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const startedAt = Date.now();
    const output = new OutputLimiter(request.maxOutputBytes);
    let timedOut = false;
    let spawnError: Error | undefined;

    const child = spawn(request.executable, [...(request.args ?? [])], {
      cwd: request.cwd,
      env: request.env,
      shell: request.shell ?? false,
      detached: true,
      windowsHide: true,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    child.stdout!.on("data", (chunk: Buffer) => output.append("stdout", chunk));
    child.stderr!.on("data", (chunk: Buffer) => output.append("stderr", chunk));
    child.on("error", (error) => {
      spawnError = error;
    });

    if (request.stdin !== undefined) child.stdin!.end(request.stdin);

    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        void terminateTree(child.pid, false).then(() => {
          const forceTimer = setTimeout(() => void terminateTree(child.pid!, true), 1_000);
          forceTimer.unref();
        });
      }
    }, request.timeoutMs);
    timer.unref();

    const [exitCode] = (await once(child, "close")) as [number | null, NodeJS.Signals | null];
    clearTimeout(timer);

    if (child.pid !== undefined) {
      await terminateTree(child.pid, timedOut).catch(() => undefined);
    }

    if (spawnError !== undefined) output.append("stderr", spawnError.message);
    const limited = output.result();
    return {
      exitCode,
      ...limited,
      cwd: request.cwd,
      durationMs: Date.now() - startedAt,
      timedOut,
    };
  }
}
