// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hash } from "starknet";
import type { ExecutableAccount } from "@/sharding/types";
import { useShardStore } from "./store/use-shard-store";
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

const SHARDING_REQUESTED_SELECTOR = hash.getSelectorFromName("ShardingRequested").toLowerCase();

const buildReceipt = (params: { gameAddress: string; shardContractAddress: string; onchainShardId: string }) => ({
  events: [
    {
      from_address: params.shardContractAddress,
      keys: [SHARDING_REQUESTED_SELECTOR, params.gameAddress],
      data: [params.onchainShardId],
    },
  ],
});

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
    useShardStore.getState().clearMainShardRequestState();
    sessionStorage.clear();
    delete (window as Window & { __ETERNUM_LAST_SHARD_REQUEST_RECEIPT__?: unknown }).__ETERNUM_LAST_SHARD_REQUEST_RECEIPT__;

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
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x1" }),
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
    expect(current.errorCode).toBe("OPERATOR_CONFIG_FAILED");
    expect(current.error).toContain("shard_contract_address");
  });

  it("fails fast when account cannot resolve tx receipt", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x1" }),
    };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
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
    expect(current.errorCode).toBe("RECEIPT_UNSUPPORTED");
    expect(current.error).toContain("receipt lookup");
  });

  it("fails fast when shard status response is invalid while polling", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
      waitForTransaction: vi
        .fn<NonNullable<ExecutableAccount["waitForTransaction"]>>()
        .mockResolvedValue(buildReceipt({
          gameAddress: "0xabc123",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        })),
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
    await act(async () => Promise.resolve());

    const current = getHookState(latestState);
    expect(current.phase).toBe("error");
    expect(current.errorCode).toBe("POLL_FAILED");
    expect(current.error).toContain("shards array");
  });

  it("recovers shard id from operator status when receipt does not expose ShardingRequested event", async () => {
    const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
      waitForTransaction: vi
        .fn<NonNullable<ExecutableAccount["waitForTransaction"]>>()
        .mockResolvedValue({ events: [] }),
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transport: {
              status: "healthy",
              torii_http_reachable: true,
              torii_sql_reachable: true,
              torii_grpc_reachable: true,
              bootstrap_snapshot_present: true,
              error_code: null,
              error_message: null,
            },
          }),
          { status: 200 },
        ),
      );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42]);
    });
    await act(async () => Promise.resolve());

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[ShardRequest] Failed to resolve ShardingRequested event from receipt",
      expect.objectContaining({
        txHash: "0x111",
        reason: "ShardingRequested event not found in transaction receipt",
        extractedEventCount: 0,
      }),
    );
    expect(sessionStorage.getItem("__eternum_last_shard_request_receipt__")).toContain("\"txHash\":\"0x111\"");
    expect((window as Window & { __ETERNUM_LAST_SHARD_REQUEST_RECEIPT__?: unknown }).__ETERNUM_LAST_SHARD_REQUEST_RECEIPT__).toEqual(
      expect.objectContaining({
        txHash: "0x111",
      }),
    );
    expect(getHookState(latestState).phase).toBe("ready");
    expect(getHookState(latestState).targetShardId).toBe("0xabc123@0x9");
    expect(getHookState(latestState).shardUrls?.shardId).toBe("0xabc123@0x9");
    consoleWarnSpy.mockRestore();
  });

  it("extracts ShardingRequested from wrapped transaction_receipt event shape", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
      waitForTransaction: vi.fn<NonNullable<ExecutableAccount["waitForTransaction"]>>().mockResolvedValue({
        transaction_receipt: {
          events: [
            {
              event: {
                fromAddress: "0x1234abcd",
                keys: [SHARDING_REQUESTED_SELECTOR, "0xabc123"],
                data: ["0x9"],
              },
            },
          ],
        },
      }),
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transport: {
              status: "healthy",
              torii_http_reachable: true,
              torii_sql_reachable: true,
              torii_grpc_reachable: true,
              bootstrap_snapshot_present: true,
              error_code: null,
              error_message: null,
            },
          }),
          { status: 200 },
        ),
      );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42]);
    });
    await act(async () => Promise.resolve());

    expect(getHookState(latestState).phase).toBe("ready");
    expect(getHookState(latestState).targetShardId).toBe("0xabc123@0x9");
  });

  it("recovers an existing shard when request_shard_all fails with slot locked by shard", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockRejectedValue(new Error("Component: Slot locked by shard")),
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transport: {
              status: "healthy",
              torii_http_reachable: true,
              torii_sql_reachable: true,
              torii_grpc_reachable: true,
              bootstrap_snapshot_present: true,
              error_code: null,
              error_message: null,
            },
          }),
          { status: 200 },
        ),
      );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42]);
    });
    await act(async () => Promise.resolve());

    expect(getHookState(latestState).phase).toBe("ready");
    expect(getHookState(latestState).targetShardId).toBe("0xabc123@0x9");
  });

  it("waits for healthy transport of the requested shard id", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
      waitForTransaction: vi
        .fn<NonNullable<ExecutableAccount["waitForTransaction"]>>()
        .mockResolvedValue(buildReceipt({
          gameAddress: "0xabc123",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        })),
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5051",
                torii_url: "http://localhost:8081",
                torii_grpc_url: "http://localhost:18091",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x99",
              },
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transport: {
              status: "degraded",
              torii_http_reachable: true,
              torii_sql_reachable: true,
              torii_grpc_reachable: false,
              bootstrap_snapshot_present: false,
              error_code: "bootstrap_snapshot_missing",
              error_message: "Bootstrap snapshot not captured yet",
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transport: {
              status: "healthy",
              torii_http_reachable: true,
              torii_sql_reachable: true,
              torii_grpc_reachable: true,
              bootstrap_snapshot_present: true,
              error_code: null,
              error_message: null,
            },
          }),
          { status: 200 },
        ),
      );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42]);
    });
    expect(getHookState(latestState).phase).toBe("waiting");
    expect(getHookState(latestState).targetShardId).toBe("0xabc123@0x9");
    expect(useShardStore.getState().mainShardRequestPhase).toBe("waiting");
    expect(useShardStore.getState().mainShardTargetShardId).toBe("0xabc123@0x9");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(getHookState(latestState).phase).toBe("ready");
    expect(getHookState(latestState).shardUrls?.shardId).toBe("0xabc123@0x9");
    expect(useShardStore.getState().mainShardRequestPhase).toBe("ready");
    expect(useShardStore.getState().mainShardTargetShardId).toBe("0xabc123@0x9");
  });

  it("recovers polling for an already requested shard after an operator-side error", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
      waitForTransaction: vi
        .fn<NonNullable<ExecutableAccount["waitForTransaction"]>>()
        .mockResolvedValue(buildReceipt({
          gameAddress: "0xabc123",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        })),
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
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transport: {
              status: "healthy",
              torii_http_reachable: true,
              torii_sql_reachable: true,
              torii_grpc_reachable: true,
              bootstrap_snapshot_present: true,
              error_code: null,
              error_message: null,
            },
          }),
          { status: 200 },
        ),
      );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42]);
    });
    await act(async () => Promise.resolve());

    expect(getHookState(latestState).phase).toBe("error");
    expect(getHookState(latestState).targetShardId).toBe("0xabc123@0x9");

    await act(async () => {
      await getHookState(latestState).recoverShard();
    });
    await act(async () => Promise.resolve());

    expect(getHookState(latestState).phase).toBe("ready");
    expect(getHookState(latestState).shardUrls?.shardId).toBe("0xabc123@0x9");
  });

  it("recovers from operator status without callContract support", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "torii_ready",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              {
                phase: "gameplay_active",
                katana_url: "http://localhost:5050",
                torii_url: "http://localhost:8080",
                torii_grpc_url: "http://localhost:18090",
                game_contract_address: "0xabc123",
                shard_id: "0xabc123@0x9",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            transport: {
              status: "healthy",
              torii_http_reachable: true,
              torii_sql_reachable: true,
              torii_grpc_reachable: true,
              bootstrap_snapshot_present: true,
              error_code: null,
              error_message: null,
            },
          }),
          { status: 200 },
        ),
      );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).recoverShard();
    });
    await act(async () => Promise.resolve());

    expect(getHookState(latestState).phase).toBe("ready");
    expect(getHookState(latestState).targetShardId).toBe("0xabc123@0x9");
    expect(getHookState(latestState).shardUrls?.shardId).toBe("0xabc123@0x9");
  });
});
