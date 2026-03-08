import { beforeEach, describe, expect, it } from "vitest";

import { buildPlaySceneUrl } from "./location-url";

describe("buildPlaySceneUrl", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/play");
  });

  it("preserves shard query params while updating tile coordinates", () => {
    window.history.replaceState(
      {},
      "",
      "/play?shard_rpc=http://localhost:15051&shard_torii=https://localhost:18080&shard_id=0xabc@0x1&shard_operator=http://localhost:3001",
    );

    const next = buildPlaySceneUrl("hex", 12, -7);

    expect(next.startsWith("/play/hex?")).toBe(true);
    const params = new URLSearchParams(next.split("?")[1] ?? "");
    expect(params.get("shard_rpc")).toBe("http://localhost:15051");
    expect(params.get("shard_torii")).toBe("https://localhost:18080");
    expect(params.get("col")).toBe("12");
    expect(params.get("row")).toBe("-7");
  });

  it("keeps the active world slug when current path is /play/:world/...", () => {
    window.history.replaceState({}, "", "/play/devworld/map?foo=bar");

    const next = buildPlaySceneUrl("hex", 3, 4);

    expect(next.startsWith("/play/devworld/hex?")).toBe(true);
    const params = new URLSearchParams(next.split("?")[1] ?? "");
    expect(params.get("foo")).toBe("bar");
    expect(params.get("col")).toBe("3");
    expect(params.get("row")).toBe("4");
  });

  it("recovers to /play/* when current path already escaped to /hex", () => {
    window.history.replaceState({}, "", "/hex?shard_rpc=http://localhost:15051");

    const next = buildPlaySceneUrl("map", 0, 8);

    expect(next.startsWith("/play/map?")).toBe(true);
    const params = new URLSearchParams(next.split("?")[1] ?? "");
    expect(params.get("shard_rpc")).toBe("http://localhost:15051");
    expect(params.get("col")).toBe("0");
    expect(params.get("row")).toBe("8");
  });

  it("can force spectate query flag", () => {
    window.history.replaceState({}, "", "/play/hex?col=0&row=0");

    const next = buildPlaySceneUrl("map", 1, 2, { spectate: true });

    const params = new URLSearchParams(next.split("?")[1] ?? "");
    expect(params.get("spectate")).toBe("true");
    expect(params.get("col")).toBe("1");
    expect(params.get("row")).toBe("2");
  });

  it("can clear stale spectate query flag", () => {
    window.history.replaceState({}, "", "/play/map?spectate=true");

    const next = buildPlaySceneUrl("hex", 5, 6, { spectate: false });

    const params = new URLSearchParams(next.split("?")[1] ?? "");
    expect(params.get("spectate")).toBeNull();
    expect(params.get("col")).toBe("5");
    expect(params.get("row")).toBe("6");
  });
});
