// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { resolveRuntimeContext } from "@/sharding/runtime-context";
import { useShardStore } from "./use-shard-store";

const resetStore = () => {
  useShardStore.setState({
    runtimeContext: null,
    isShardMode: false,
    shardId: null,
    operatorUrl: null,
    shardRpcUrl: null,
    shardToriiUrl: null,
    shardToriiGrpcUrl: null,
    mainUrl: null,
    mainGameReturnUrl: null,
    mainShardRequestPhase: "idle",
    mainShardTargetShardId: null,
    mainShardRequestErrorCode: null,
    mainShardRequestError: null,
  });
};

describe("use-shard-store runtime context", () => {
  beforeEach(() => {
    sessionStorage.clear();
    resetStore();
  });

  it("stores canonical main return url when entering shard mode", () => {
    const runtimeContext = resolveRuntimeContext(
      "https://localhost:5173/play/map?col=2&row=3&shard_rpc=http://localhost:15051&shard_torii=https://localhost:18080&shard_torii_grpc=http://localhost:18090&shard_id=0xabc@0x1&shard_operator=http://localhost:3001",
    );

    if (runtimeContext.kind !== "shard") {
      throw new Error("expected shard runtime context");
    }

    useShardStore.getState().enterShardMode(
      {
        ...runtimeContext.shard,
        mainUrl: null,
      },
      runtimeContext,
    );

    const state = useShardStore.getState();
    expect(state.isShardMode).toBe(true);
    expect(state.mainGameReturnUrl).toContain("/play/map?");
    expect(state.mainGameReturnUrl).toContain("col=2");
    expect(state.mainGameReturnUrl).toContain("row=3");

    const storedSession = sessionStorage.getItem("shard_mode");
    expect(storedSession).toContain("mainUrl");
  });

  it("clears shard state without dropping main runtime context", () => {
    const mainRuntimeContext = resolveRuntimeContext("https://localhost:5173/play/hex?col=1&row=9");
    useShardStore.getState().setRuntimeContext(mainRuntimeContext);

    useShardStore.getState().clearShardMode();

    const state = useShardStore.getState();
    expect(state.runtimeContext?.kind).toBe("main");
    expect(state.isShardMode).toBe(false);
    expect(state.mainGameReturnUrl).toBeNull();
  });

  it("clears pending main shard request state when entering shard mode", () => {
    useShardStore.getState().setMainShardRequestState({
      phase: "ready",
      targetShardId: "0xabc123@0x9",
    });

    const runtimeContext = resolveRuntimeContext(
      "https://localhost:5173/play/map?col=2&row=3&shard_rpc=http://localhost:15051&shard_torii=https://localhost:18080&shard_torii_grpc=http://localhost:18090&shard_id=0xabc@0x1&shard_operator=http://localhost:3001",
    );

    if (runtimeContext.kind !== "shard") {
      throw new Error("expected shard runtime context");
    }

    useShardStore.getState().enterShardMode(
      {
        ...runtimeContext.shard,
        mainUrl: null,
      },
      runtimeContext,
    );

    const state = useShardStore.getState();
    expect(state.mainShardRequestPhase).toBe("idle");
    expect(state.mainShardTargetShardId).toBeNull();
  });
});
