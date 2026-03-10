// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveRuntimeContext } from "@/sharding/runtime-context";
import { useShardStore } from "./store/use-shard-store";
import { useMainShardWriteGuard } from "./use-main-shard-write-guard";

type HookState = ReturnType<typeof useMainShardWriteGuard>;

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

describe("useMainShardWriteGuard", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestState: HookState | null;

  const HookHarness = () => {
    const state = useMainShardWriteGuard();
    useEffect(() => {
      latestState = state;
    }, [state]);
    return null;
  };

  const getHookState = (): HookState => {
    if (latestState === null) {
      throw new Error("Hook state was not initialized");
    }
    return latestState;
  };

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    latestState = null;
    resetStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<HookHarness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("blocks main-chain writes while shard request is waiting", async () => {
    await act(async () => {
      useShardStore.getState().setMainShardRequestState({
        phase: "waiting",
        targetShardId: "0xabc123@0x9",
      });
    });

    const state = getHookState();
    expect(state.isWriteBlocked).toBe(true);
    expect(state.mainShardRequestPhase).toBe("waiting");
    expect(state.mainShardTargetShardId).toBe("0xabc123@0x9");
    expect(state.writeBlockReason).toContain("Shard is preparing");
  });

  it("does not block writes once runtime switches into shard mode", async () => {
    const runtimeContext = resolveRuntimeContext(
      "https://localhost:5173/play/map?col=2&row=3&shard_rpc=http://localhost:15051&shard_torii=https://localhost:18080&shard_torii_grpc=http://localhost:18090&shard_id=0xabc@0x1&shard_operator=http://localhost:3001",
    );

    await act(async () => {
      useShardStore.getState().setMainShardRequestState({
        phase: "ready",
        targetShardId: "0xabc123@0x9",
      });
      useShardStore.getState().setRuntimeContext(runtimeContext);
    });

    const state = getHookState();
    expect(state.isWriteBlocked).toBe(false);
    expect(state.mainShardRequestPhase).toBe("idle");
    expect(state.writeBlockReason).toBeNull();
  });
});
