import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CommandPolicy } from "../src/security/command-policy.js";

describe("CommandPolicy", () => {
  const policy = new CommandPolicy();

  it.each([
    "rm -rf /",
    "Remove-Item C:\\ -Recurse -Force",
    "sudo npm test",
    "git reset --hard",
    "git clean -fdx",
    "git push origin main --force",
    "git push origin --delete main",
    "npm publish",
    "cat ~/.ssh/id_rsa",
    "cat ../outside/.env",
  ])("blocks dangerous shell command: %s", (command) => {
    expect(() => policy.assertShell(command)).toThrow();
  });

  it("allows normal build and piped read-only commands", () => {
    expect(() => policy.assertCommand("npm", ["test"])).not.toThrow();
    expect(() => policy.assertShell("rg TODO src | head -20")).not.toThrow();
  });

  it("rejects executables outside the allowlist", () => {
    expect(() => policy.assertCommand("curl", ["https://example.com"])).toThrow(/allowlisted/i);
    expect(() => policy.assertCommand(path.join(os.tmpdir(), "node"), ["--version"])).toThrow(
      /absolute executable/i,
    );
  });
});
