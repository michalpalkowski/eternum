import { describe, expect, it } from "vitest";
import {
  ShardProtocolError,
  buildShardPlayUrl,
  extractGameContractFromShardId,
  parseShardIdParts,
  parseActiveShardFromStatusResponse,
  parseOperatorConfigResponse,
  parseTransportHealthFromStatusResponse,
  parseSettlementStreamEvent,
  parseShardUrlParams,
  parseStoredShardSession,
  resolveShardSession,
} from "./protocol";

describe("sharding protocol", () => {
  it("parses valid shard query params", () => {
    const params = parseShardUrlParams(
      "?shard_rpc=http://localhost:5050&shard_torii=http://localhost:8080&shard_torii_grpc=http://localhost:18090&shard_id=0xabc@1&shard_operator=http://localhost:3001&shard_main=https://localhost:5173/play",
    );

    expect(params).toEqual({
      rpcUrl: "http://localhost:5050",
      toriiUrl: "http://localhost:8080",
      toriiGrpcUrl: "http://localhost:18090",
      shardId: "0xabc@1",
      operatorUrl: "http://localhost:3001",
      mainUrl: "https://localhost:5173/play",
    });
  });

  it("falls back to shard_torii when shard_torii_grpc is missing", () => {
    const params = parseShardUrlParams(
      "?shard_rpc=http://localhost:5050&shard_torii=http://localhost:8080&shard_id=0xabc@1&shard_operator=http://localhost:3001",
    );

    expect(params?.toriiGrpcUrl).toBe("http://localhost:8080");
    expect(params?.mainUrl).toBeNull();
  });

  it("prefers secure shard_torii when shard_torii_grpc is insecure", () => {
    const params = parseShardUrlParams(
      "?shard_rpc=http://localhost:5050&shard_torii=https://localhost:18080&shard_torii_grpc=http://localhost:18090&shard_id=0xabc@1&shard_operator=http://localhost:3001",
    );

    expect(params?.toriiUrl).toBe("https://localhost:18080");
    expect(params?.toriiGrpcUrl).toBe("https://localhost:18080");
  });

  it("rejects partially defined shard query params", () => {
    expect(() => parseShardUrlParams("?shard_rpc=http://localhost:5050")).toThrowError(ShardProtocolError);
  });

  it("resolves shard session from query before session storage", () => {
    const resolved = resolveShardSession(
      "?shard_rpc=http://localhost:5050&shard_torii=http://localhost:8080&shard_id=0xabc@1&shard_operator=http://localhost:3001",
      JSON.stringify({
        shardId: "0xdead@2",
        operatorUrl: "http://localhost:4001",
        rpcUrl: "http://localhost:6050",
        toriiUrl: "http://localhost:9080",
      }),
    );

    expect(resolved?.shardId).toBe("0xabc@1");
  });

  it("rejects invalid stored shard session JSON", () => {
    expect(() => parseStoredShardSession("{not-json")).toThrowError(ShardProtocolError);
  });

  it("normalizes stored shard session to secure torii endpoint when grpc url is insecure", () => {
    const session = parseStoredShardSession(
      JSON.stringify({
        shardId: "0xabc@1",
        operatorUrl: "http://localhost:3001",
        rpcUrl: "http://localhost:5050",
        toriiUrl: "https://localhost:18080",
        toriiGrpcUrl: "http://localhost:18090",
      }),
    );

    expect(session.toriiGrpcUrl).toBe("https://localhost:18080");
  });

  it("parses operator config payload", () => {
    const config = parseOperatorConfigResponse({ shard_contract_address: "0x1234abcd" });
    expect(config.shardContractAddress).toBe("0x1234abcd");
  });

  it("rejects malformed operator status payload", () => {
    expect(() => parseActiveShardFromStatusResponse({ shards: "invalid" })).toThrowError(ShardProtocolError);
  });

  it("extracts active shard from status payload", () => {
    const activeShard = parseActiveShardFromStatusResponse({
      shards: [
        { phase: "initializing" },
        {
          phase: "gameplay_active",
          katana_url: "http://localhost:5050",
          torii_url: "http://localhost:8080",
          torii_grpc_url: "http://localhost:8081",
          game_contract_address: "0x1234abcd",
          shard_id: "0x1234abcd@42",
        },
      ],
    });

    expect(activeShard).toEqual({
      katanaUrl: "http://localhost:5050",
      toriiUrl: "http://localhost:8080",
      toriiGrpcUrl: "http://localhost:8081",
      gameContractAddress: "0x1234abcd",
      shardId: "0x1234abcd@42",
    });
  });

  it("parses transport health payload", () => {
    const transport = parseTransportHealthFromStatusResponse({
      transport: {
        status: "degraded",
        torii_http_reachable: true,
        torii_sql_reachable: false,
        torii_grpc_reachable: false,
        bootstrap_snapshot_present: false,
        error_code: "torii_sql_unreachable",
        error_message: "sql endpoint returned non-success status: 500",
      },
    });

    expect(transport).toEqual({
      status: "degraded",
      toriiHttpReachable: true,
      toriiSqlReachable: false,
      toriiGrpcReachable: false,
      bootstrapSnapshotPresent: false,
      errorCode: "torii_sql_unreachable",
      errorMessage: "sql endpoint returned non-success status: 500",
    });
  });

  it("rejects malformed transport health payload", () => {
    expect(() =>
      parseTransportHealthFromStatusResponse({
        transport: {
          status: "unknown",
          torii_http_reachable: true,
          torii_sql_reachable: true,
          torii_grpc_reachable: true,
          bootstrap_snapshot_present: true,
        },
      }),
    ).toThrowError(ShardProtocolError);
  });

  it("parses settlement stream events", () => {
    const settling = parseSettlementStreamEvent("settling", JSON.stringify({ step_label: "Applying state" }));
    const completed = parseSettlementStreamEvent("completed", "{}");
    const failed = parseSettlementStreamEvent("failed", JSON.stringify({ reason: "boom" }));

    expect(settling).toEqual({ type: "settling", stepLabel: "Applying state" });
    expect(completed).toEqual({ type: "completed" });
    expect(failed).toEqual({ type: "failed", reason: "boom" });
  });

  it("extracts game contract from shard id", () => {
    expect(extractGameContractFromShardId("0xabc123@7")).toBe("0xabc123");
  });

  it("parses shard id into game contract and onchain id", () => {
    expect(parseShardIdParts("0xabc123@0x7")).toEqual({
      gameContractAddress: "0xabc123",
      onchainShardId: "0x7",
    });
  });

  it("builds shard play URL", () => {
    const url = buildShardPlayUrl("https://example.com", {
      rpcUrl: "https://rpc.example.com",
      toriiUrl: "https://torii.example.com",
      toriiGrpcUrl: "https://torii-grpc.example.com",
      shardId: "0xabc123@7",
      operatorUrl: "https://operator.example.com",
      mainUrl: "https://localhost:5173/play",
    });

    expect(url).toContain("https://example.com/play?");
    expect(url).toContain("shard_rpc=");
    expect(url).toContain("shard_torii=");
    expect(url).toContain("shard_torii_grpc=");
    expect(url).toContain("shard_id=");
    expect(url).toContain("shard_operator=");
    expect(url).toContain("shard_main=");
  });
});
