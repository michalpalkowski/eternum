import { describe, expect, it } from "vitest";

import { buildSceneUrl, resolveMainGameReturnUrl, resolveRuntimeContext } from "./runtime-context";

describe("runtime-context", () => {
  it("resolves main runtime context with world-scoped play base path", () => {
    const context = resolveRuntimeContext("https://localhost:5173/play/devworld/map?col=1&row=2");

    expect(context.kind).toBe("main");
    expect(context.playBasePath).toBe("/play/devworld");
  });

  it("resolves shard runtime context and computes canonical main return url", () => {
    const context = resolveRuntimeContext(
      "https://localhost:5173/play/hex?col=9&row=4&shard_rpc=http://localhost:15051&shard_torii=https://localhost:18080&shard_torii_grpc=http://localhost:18090&shard_id=0xabc@0x1&shard_operator=http://localhost:3001&shard_main=https%3A%2F%2Flocalhost%3A5173%2Fhex%3Fcol%3D0%26row%3D8",
    );

    if (context.kind !== "shard") {
      throw new Error("expected shard context");
    }

    expect(context.mainGameReturnUrl).toContain("/play/hex?");
    expect(context.mainGameReturnUrl).toContain("col=0");
    expect(context.mainGameReturnUrl).toContain("row=8");
    expect(context.mainGameReturnUrl).not.toContain("shard_rpc=");
  });

  it("builds main scene url without shard query params", () => {
    const context = resolveRuntimeContext("https://localhost:5173/play/map?col=1&row=2&foo=bar");
    const url = buildSceneUrl(context, "hex", 7, 8);

    expect(url.startsWith("/play/hex?")).toBe(true);
    const params = new URLSearchParams(url.split("?")[1] ?? "");
    expect(params.get("foo")).toBe("bar");
    expect(params.get("col")).toBe("7");
    expect(params.get("row")).toBe("8");
    expect(params.get("shard_rpc")).toBeNull();
  });

  it("builds shard scene url preserving shard session params", () => {
    const context = resolveRuntimeContext(
      "https://localhost:5173/play/map?col=1&row=2&shard_rpc=http://localhost:15051&shard_torii=https://localhost:18080&shard_torii_grpc=http://localhost:18090&shard_id=0xabc@0x1&shard_operator=http://localhost:3001",
    );

    if (context.kind !== "shard") {
      throw new Error("expected shard context");
    }

    const url = buildSceneUrl(context, "hex", -3, 11, { spectate: true });
    const params = new URLSearchParams(url.split("?")[1] ?? "");

    expect(params.get("shard_rpc")).toBe("http://localhost:15051");
    expect(params.get("shard_torii")).toBe("https://localhost:18080");
    expect(params.get("shard_torii_grpc")).toBe("https://localhost:18080");
    expect(params.get("shard_id")).toBe("0xabc@0x1");
    expect(params.get("shard_operator")).toBe("http://localhost:3001");
    expect(params.get("shard_main")).toBeTruthy();
    expect(params.get("spectate")).toBe("true");
    expect(params.get("col")).toBe("-3");
    expect(params.get("row")).toBe("11");
  });

  it("resolves main return url override from shard context", () => {
    const context = resolveRuntimeContext(
      "https://localhost:5173/play/map?col=10&row=20&shard_rpc=http://localhost:15051&shard_torii=https://localhost:18080&shard_torii_grpc=http://localhost:18090&shard_id=0xabc@0x1&shard_operator=http://localhost:3001",
    );

    const url = resolveMainGameReturnUrl(context, { scene: "hex", col: 33, row: 44, spectate: false });
    const parsed = new URL(url);

    expect(parsed.pathname).toBe("/play/hex");
    expect(parsed.searchParams.get("col")).toBe("33");
    expect(parsed.searchParams.get("row")).toBe("44");
    expect(parsed.searchParams.get("spectate")).toBeNull();
    expect(parsed.searchParams.get("shard_rpc")).toBeNull();
  });

  it("does not infer scene from world slug containing hex/map substrings", () => {
    const context = resolveRuntimeContext("https://localhost:5173/play/dev-hex-world?col=4&row=5");
    const url = resolveMainGameReturnUrl(context);
    const parsed = new URL(url);

    expect(parsed.pathname).toBe("/play/dev-hex-world/map");
    expect(parsed.searchParams.get("col")).toBe("4");
    expect(parsed.searchParams.get("row")).toBe("5");
  });
});
