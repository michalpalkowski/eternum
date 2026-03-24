// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutableAccount } from "@/sharding/types";
import { useShardSettlement } from "./use-shard-settlement";

const mocks = vi.hoisted(() => ({
  dojoConfig: {
    manifest: {
      world: { address: "0xabc123" },
    },
  },
  getContractByName: vi.fn(() => ({ address: "0x1234abcd" })),
}));

vi.mock("../../dojo-config", () => ({
  dojoConfig: mocks.dojoConfig,
}));

vi.mock("@dojoengine/core", () => ({
  getContractByName: mocks.getContractByName,
}));

type HookState = ReturnType<typeof useShardSettlement>;

class MockEventSource {
  public static readonly instances: MockEventSource[] = [];
  public readonly url: string;
  public onerror: ((this: EventSource, ev: Event) => unknown) | null = null;

  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  public constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const callback =
      typeof listener === "function"
        ? listener
        : (event: Event) => {
            listener.handleEvent(event);
          };
    const existing = this.listeners.get(type) ?? [];
    existing.push(callback);
    this.listeners.set(type, existing);
  }

  public close(): void {}

  public emit(type: string, payload: unknown = {}): void {
    const event = new MessageEvent(type, {
      data: typeof payload === "string" ? payload : JSON.stringify(payload),
    });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("useShardSettlement", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestState: HookState | null;

  const HookHarness = ({
    account,
    shardId,
    operatorUrl,
  }: {
    account: ExecutableAccount | null;
    shardId: string | null;
    operatorUrl: string | null;
  }) => {
    const state = useShardSettlement({ account, shardId, operatorUrl });
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

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    latestState = null;
    MockEventSource.instances.length = 0;
    mocks.dojoConfig.manifest.world.address = "0xabc123";
    (globalThis as { EventSource: typeof EventSource }).EventSource = MockEventSource as unknown as typeof EventSource;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("transitions from waiting to complete on settlement stream events", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue(undefined),
    };

    await act(async () => {
      root.render(<HookHarness account={account} shardId="0xabc123@9" operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState().startSettlement();
    });
    expect(getHookState().phase).toBe("waiting");
    expect(MockEventSource.instances).toHaveLength(1);

    await act(async () => {
      MockEventSource.instances[0].emit("settling", { shard_id: "0xabc123@9", step_label: "Applying shard updates" });
    });
    expect(getHookState().phase).toBe("waiting");
    expect(getHookState().stepLabel).toBe("Applying shard updates");

    await act(async () => {
      MockEventSource.instances[0].emit("completed", { shard_id: "0xabc123@9" });
    });
    expect(getHookState().phase).toBe("complete");
    expect(getHookState().error).toBeNull();
  });

  it("transitions to error when settlement stream emits failed event", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue(undefined),
    };

    await act(async () => {
      root.render(<HookHarness account={account} shardId="0xabc123@9" operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState().startSettlement();
    });
    expect(getHookState().phase).toBe("waiting");

    await act(async () => {
      MockEventSource.instances[0].emit("failed", { shard_id: "0xabc123@9", reason: "Settlement failed upstream" });
    });
    expect(getHookState().phase).toBe("error");
    expect(getHookState().error).toBe("Settlement failed upstream");
  });

  it("ignores settlement events from other shard ids", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue(undefined),
    };

    await act(async () => {
      root.render(<HookHarness account={account} shardId="0xabc123@9" operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState().startSettlement();
    });
    expect(getHookState().phase).toBe("waiting");

    await act(async () => {
      MockEventSource.instances[0].emit("settling", { shard_id: "0xabc123@10", step_label: "Wrong shard" });
    });
    expect(getHookState().stepLabel).toBeNull();

    await act(async () => {
      MockEventSource.instances[0].emit("completed", { shard_id: "0xabc123@10" });
    });
    expect(getHookState().phase).toBe("waiting");

    await act(async () => {
      MockEventSource.instances[0].emit("completed", { shard_id: "0xabc123@9" });
    });
    expect(getHookState().phase).toBe("complete");
  });

  it("fails fast when the shard session world differs from the bootstrapped manifest world", async () => {
    mocks.dojoConfig.manifest.world.address = "0xdeadbeef";
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue(undefined),
    };

    await act(async () => {
      root.render(<HookHarness account={account} shardId="0xabc123@9" operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState().startSettlement();
    });

    expect(getHookState().phase).toBe("error");
    expect(getHookState().errorCode).toBe("SHARD_WORLD_MISMATCH");
    expect(getHookState().error).toContain("0xabc123");
    expect(getHookState().error).toContain("0xdeadbeef");
    expect(account.execute).not.toHaveBeenCalled();
    expect(mocks.getContractByName).not.toHaveBeenCalled();
  });
});
