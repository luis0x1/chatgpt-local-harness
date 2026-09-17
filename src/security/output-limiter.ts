export interface LimitedOutput {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export class OutputLimiter {
  private stdoutChunks: Buffer[] = [];
  private stderrChunks: Buffer[] = [];
  private usedBytes = 0;
  private wasTruncated = false;

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new Error("maxBytes must be a positive safe integer");
    }
  }

  append(stream: "stdout" | "stderr", chunk: Buffer | string): void {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = this.maxBytes - this.usedBytes;
    if (available <= 0) {
      this.wasTruncated = true;
      return;
    }
    const accepted = buffer.subarray(0, available);
    if (accepted.length < buffer.length) this.wasTruncated = true;
    this.usedBytes += accepted.length;
    if (stream === "stdout") this.stdoutChunks.push(accepted);
    else this.stderrChunks.push(accepted);
  }

  result(): LimitedOutput {
    return {
      stdout: Buffer.concat(this.stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(this.stderrChunks).toString("utf8"),
      truncated: this.wasTruncated,
    };
  }
}
