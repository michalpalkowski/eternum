// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("bootstrap shard context validation", () => {
  it("resolves shard context from URL params via protocol parser", () => {
    const source = readFileSync(resolve(process.cwd(), "src/init/bootstrap.tsx"), "utf8");
    expect(source).toContain("parseShardUrlParams(");
    expect(source).not.toContain("getShardParams(");
  });

  it("does not keep legacy shard fallback torii expressions", () => {
    const source = readFileSync(resolve(process.cwd(), "src/init/bootstrap.tsx"), "utf8");
    expect(source).not.toContain("shardParams?.torii");
    expect(source).not.toContain("shardStore.shardToriiUrl");
  });

  it("aligns the world profile with shard session world before patching the manifest", () => {
    const source = readFileSync(resolve(process.cwd(), "src/init/bootstrap.tsx"), "utf8");
    expect(source).toContain("resolveProfileForShardSession");
  });
});
