import { describe, expect, it } from "vitest";
import { isSensitivePath } from "../src/security/sensitive-path-policy.js";

describe("sensitive path policy", () => {
  it.each([
    ".git/config",
    "nested/.GIT/config",
    "node_modules/pkg.js",
    "nested\\NODE_MODULES\\pkg.js",
    "dist/output.js",
    "nested/.env.local",
    ".NPMRC",
    "keys/id_ed25519",
    "keys/signing.KEY",
    "secrets/credentials.json",
  ])("classifies protected components in %s", (candidate) => {
    expect(isSensitivePath(candidate)).toBe(true);
  });

  it.each([
    ".env.example",
    "nested/.env.example",
    "src/git-client.ts",
    "src/build-helper.ts",
    "src/auth.json.ts",
  ])("allows normal source and the explicit example exception in %s", (candidate) => {
    expect(isSensitivePath(candidate, { allowEnvExample: true })).toBe(false);
  });

  it("requires an explicit file-only exception and does not hide protected descendants", () => {
    expect(isSensitivePath(".env.example")).toBe(true);
    expect(isSensitivePath(".env.example/secret.txt", { allowEnvExample: true })).toBe(true);
    expect(isSensitivePath(".env.example\\secret.txt", { allowEnvExample: true })).toBe(true);
  });
});
