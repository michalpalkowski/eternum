// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutableAccount } from "@/sharding/types";
import { useShardRequest } from "./use-shard-request";

const { dojoConfigMock } = vi.hoisted(() => ({
  dojoConfigMock: {
    manifest: {
      world: { address: "0xabc123" },
    },
  },
}));

vi.mock("../../dojo-config", () => ({
  dojoConfig: dojoConfigMock,
}));

vi.mock("@dojoengine/core", () => ({
  getContractByName: vi.fn(() => ({ address: "0x1234abcd" })),
}));

type HookState = ReturnType<typeof useShardRequest>;

const getHookState = (state: HookState | null): HookState => {
  if (state === null) {
    throw new Error("Hook state was not initialized");
  }
  return state;
};

describe("useShardRequest", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latestState: HookState | null;
  let fetchMock: ReturnType<typeof vi.fn>;

  const HookHarness = ({ account, operatorUrl }: { account: ExecutableAccount | null; operatorUrl: string }) => {
    const state = useShardRequest(account, operatorUrl);
    useEffect(() => {
      latestState = state;
    }, [state]);
    return null;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    latestState = null;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    fetchMock = vi.fn();
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;

    dojoConfigMock.manifest = {
      world: { address: "0xabc123" },
    };
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("fails fast when operator config payload is invalid", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue(undefined),
    };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ invalid: "shape" }), {
        status: 200,
      }),
    );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42]);
    });

    const current = getHookState(latestState);
    expect(current.phase).toBe("error");
    expect(current.error).toContain("shard_contract_address");
  });

  it("fails fast when shard status response is invalid while polling", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue(undefined),
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shards: "bad-shape" }), {
          status: 200,
        }),
      );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42]);
    });
    expect(getHookState(latestState).phase).toBe("waiting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    const current = getHookState(latestState);
    expect(current.phase).toBe("error");
    expect(current.error).toContain("shards array");
  });
});
