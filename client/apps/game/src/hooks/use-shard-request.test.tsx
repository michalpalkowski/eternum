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

const buildShardStatusEntry = (params: {
  phase: string;
  gameContractAddress: string;
  shardId: string;
  katanaUrl?: string | null;
  toriiUrl?: string | null;
  toriiGrpcUrl?: string | null;
  protocol?: {
    phase?: string;
    ready?: boolean;
    retriable?: boolean;
    errorCode?: string | null;
    errorMessage?: string | null;
  };
}) => ({
  phase: params.phase,
  game_contract_address: params.gameContractAddress,
  shard_id: params.shardId,
  katana_url: params.katanaUrl ?? null,
  torii_url: params.toriiUrl ?? null,
  torii_grpc_url: params.toriiGrpcUrl ?? null,
  protocol: {
    phase: params.protocol?.phase ?? params.phase,
    ready: params.protocol?.ready ?? params.phase === "gameplay_active",
    retriable: params.protocol?.retriable ?? false,
    error_code: params.protocol?.errorCode ?? null,
    error_message: params.protocol?.errorMessage ?? null,
  },
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
    delete (window as Window & { __ETERNUM_LAST_SHARD_REQUEST_RECEIPT__?: unknown })
      .__ETERNUM_LAST_SHARD_REQUEST_RECEIPT__;
    delete (window as Window & { __ETERNUM_LAST_SHARD_REQUEST_DIAGNOSTIC__?: unknown })
      .__ETERNUM_LAST_SHARD_REQUEST_DIAGNOSTIC__;

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
    expect(current.error).toContain("invalid shape");
    expect(current.errorDiagnostic?.stage).toBe("operator_config");
    expect(current.errorDiagnostic?.kind).toBe("operator_response_invalid");
    expect(current.errorDiagnostic?.hint).toContain("/config");
    expect(current.errorDiagnostic?.details).toContain("shard_contract_address");
  });

  it("uses request_shard_realm with exclusive related ids for a single realm request", async () => {
    const execute = vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" });
    const account: ExecutableAccount = {
      execute,
      waitForTransaction: vi.fn<NonNullable<ExecutableAccount["waitForTransaction"]>>().mockResolvedValue(
        buildReceipt({
          gameAddress: "0xabc123",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        }),
      ),
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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
      await getHookState(latestState).requestShard([42], {
        explorerIds: [7, 7],
        tradeIds: [8],
      });
    });
    await act(async () => Promise.resolve());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      [
        {
          contractAddress: "0x1234abcd",
          entrypoint: "request_shard_realm",
          calldata: ["42", "2", "7", "8", "0"],
        },
      ],
      { tip: "0x0" },
    );
  });

  it("uses request_shard with merged exclusive related ids for multi-entity requests", async () => {
    const execute = vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" });
    const account: ExecutableAccount = {
      execute,
      waitForTransaction: vi.fn<NonNullable<ExecutableAccount["waitForTransaction"]>>().mockResolvedValue(
        buildReceipt({
          gameAddress: "0xabc123",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        }),
      ),
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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
      await getHookState(latestState).requestShard([42, 43], {
        explorerIds: [7],
        tradeIds: [8],
      });
    });
    await act(async () => Promise.resolve());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(
      [
        {
          contractAddress: "0x1234abcd",
          entrypoint: "request_shard",
          calldata: ["4", "42", "43", "7", "8", "0"],
        },
      ],
      { tip: "0x0" },
    );
  });

  it("fails fast when hyperstructure related ids are provided", async () => {
    const execute = vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" });
    const account: ExecutableAccount = { execute };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
        status: 200,
      }),
    );

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42], {
        hyperstructureIds: [9],
      });
    });

    const current = getHookState(latestState);
    expect(current.phase).toBe("error");
    expect(current.errorCode).toBe("INVALID_ENTITY_IDS");
    expect(current.error).toContain("Hyperstructure related IDs are not supported");
    expect(current.errorDiagnostic?.stage).toBe("validation");
    expect(current.errorDiagnostic?.kind).toBe("invalid_entity_ids");
    expect(current.errorDiagnostic?.hint).toContain("policy audit");
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails fast when related ids exceed on-chain limit", async () => {
    const execute = vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" });
    const account: ExecutableAccount = { execute };

    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
        status: 200,
      }),
    );

    const tooManyTradeIds = Array.from({ length: 513 }, (_, idx) => idx + 1);

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42], {
        tradeIds: tooManyTradeIds,
      });
    });

    const current = getHookState(latestState);
    expect(current.phase).toBe("error");
    expect(current.errorCode).toBe("INVALID_ENTITY_IDS");
    expect(current.error).toContain("Related entity IDs are invalid");
    expect(current.errorDiagnostic?.stage).toBe("validation");
    expect(current.errorDiagnostic?.kind).toBe("invalid_entity_ids");
    expect(current.errorDiagnostic?.details).toContain("tradeIds exceeds max 512 ids");
    expect(execute).not.toHaveBeenCalled();
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
      waitForTransaction: vi.fn<NonNullable<ExecutableAccount["waitForTransaction"]>>().mockResolvedValue(
        buildReceipt({
          gameAddress: "0xabc123",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        }),
      ),
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
    expect(current.error).toContain("invalid shape");
    expect(current.errorDiagnostic?.details).toContain("shards array");
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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
        reason: "Transaction receipt does not contain a ShardingRequested event",
        stage: "receipt_parse",
        kind: "receipt_event_missing",
        extractedEventCount: 0,
      }),
    );
    expect(sessionStorage.getItem("__eternum_last_shard_request_receipt__")).toContain('"txHash":"0x111"');
    expect(
      (window as Window & { __ETERNUM_LAST_SHARD_REQUEST_RECEIPT__?: unknown }).__ETERNUM_LAST_SHARD_REQUEST_RECEIPT__,
    ).toEqual(
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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

  it("uses the game contract from receipt when the expected world address is stale", async () => {
    dojoConfigMock.manifest = {
      world: { address: "0xabc123" },
    };

    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
      waitForTransaction: vi.fn<NonNullable<ExecutableAccount["waitForTransaction"]>>().mockResolvedValue(
        buildReceipt({
          gameAddress: "0xdef456",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        }),
      ),
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xdef456",
                shardId: "0xdef456@0x9",
              }),
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
    expect(getHookState(latestState).targetShardId).toBe("0xdef456@0x9");
    expect(getHookState(latestState).shardUrls?.gameContractAddress).toBe("0xdef456");
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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

  it("reports a typed diagnostic when slot-locked recovery from operator also fails", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockRejectedValue(new Error("Component: Slot locked by shard")),
    };

    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shard_contract_address: "0x1234abcd" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).requestShard([42]);
    });
    await act(async () => Promise.resolve());

    const current = getHookState(latestState);
    expect(current.phase).toBe("error");
    expect(current.errorCode).toBe("EXECUTE_FAILED");
    expect(current.errorDiagnostic?.stage).toBe("operator_recovery");
    expect(current.errorDiagnostic?.kind).toBe("contract_slot_locked");
    expect(current.errorDiagnostic?.hint).toContain("previous shard");
  });

  it("waits for healthy transport of the requested shard id", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
      waitForTransaction: vi.fn<NonNullable<ExecutableAccount["waitForTransaction"]>>().mockResolvedValue(
        buildReceipt({
          gameAddress: "0xabc123",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        }),
      ),
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5051",
                toriiUrl: "http://localhost:8081",
                toriiGrpcUrl: "http://localhost:18091",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x99",
              }),
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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
      waitForTransaction: vi.fn<NonNullable<ExecutableAccount["waitForTransaction"]>>().mockResolvedValue(
        buildReceipt({
          gameAddress: "0xabc123",
          shardContractAddress: "0x1234abcd",
          onchainShardId: "0x9",
        }),
      ),
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
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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
              buildShardStatusEntry({
                phase: "torii_ready",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
                protocol: {
                  ready: false,
                },
              }),
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            shards: [
              buildShardStatusEntry({
                phase: "gameplay_active",
                katanaUrl: "http://localhost:5050",
                toriiUrl: "http://localhost:8080",
                toriiGrpcUrl: "http://localhost:18090",
                gameContractAddress: "0xabc123",
                shardId: "0xabc123@0x9",
              }),
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

  it("treats operator 404 during recovery as 'no active shard' and stays idle", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
    };

    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));

    await act(async () => {
      root.render(<HookHarness account={account} operatorUrl="http://localhost:3001" />);
    });

    await act(async () => {
      await getHookState(latestState).recoverShard();
    });
    await act(async () => Promise.resolve());

    const current = getHookState(latestState);
    expect(current.phase).toBe("idle");
    expect(current.errorCode).toBeNull();
    expect(current.errorDiagnostic).toBeNull();
    expect(current.targetShardId).toBeNull();
  });

  it("fails recovery when operator reports multiple recoverable shards for the same world", async () => {
    const account: ExecutableAccount = {
      execute: vi.fn<ExecutableAccount["execute"]>().mockResolvedValue({ transaction_hash: "0x111" }),
    };

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          shards: [
            buildShardStatusEntry({
              phase: "gameplay_active",
              katanaUrl: "http://localhost:5050",
              toriiUrl: "http://localhost:8080",
              toriiGrpcUrl: "http://localhost:18090",
              gameContractAddress: "0xabc123",
              shardId: "0xabc123@0x9",
            }),
            buildShardStatusEntry({
              phase: "torii_ready",
              katanaUrl: "http://localhost:5051",
              toriiUrl: "http://localhost:8081",
              toriiGrpcUrl: "http://localhost:18091",
              gameContractAddress: "0xabc123",
              shardId: "0xabc123@0xa",
              protocol: {
                ready: false,
              },
            }),
          ],
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

    const current = getHookState(latestState);
    expect(current.phase).toBe("error");
    expect(current.errorCode).toBe("SHARD_ID_RESOLUTION_FAILED");
    expect(current.errorDiagnostic?.summary).toContain("Failed to recover an active shard");
    expect(current.errorDiagnostic?.hint).toContain("world address");
  });
});
