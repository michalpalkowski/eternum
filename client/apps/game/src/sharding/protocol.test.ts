import { describe, expect, it } from "vitest";
import {
  ShardProtocolError,
  buildShardPlayUrl,
  extractGameContractFromShardId,
  parseActiveShardFromStatusResponse,
  parseOperatorConfigResponse,
  parseSettlementStreamEvent,
  parseShardUrlParams,
  parseStoredShardSession,
  resolveShardSession,
} from "./protocol";

describe("sharding protocol", () => {
  it("parses valid shard query params", () => {
    const params = parseShardUrlParams(
      "?shard_rpc=http://localhost:5050&shard_torii=http://localhost:8080&shard_id=0xabc@1&shard_operator=http://localhost:3001",
    );

    expect(params).toEqual({
      rpcUrl: "http://localhost:5050/",
      toriiUrl: "http://localhost:8080/",
      shardId: "0xabc@1",
      operatorUrl: "http://localhost:3001/",
    });
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
      katanaUrl: "http://localhost:5050/",
      toriiUrl: "http://localhost:8080/",
      toriiGrpcUrl: "http://localhost:8081",
      gameContractAddress: "0x1234abcd",
      shardId: "0x1234abcd@42",
    });
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

  it("builds shard play URL", () => {
    const url = buildShardPlayUrl("https://example.com", {
      rpcUrl: "https://rpc.example.com",
      toriiUrl: "https://torii.example.com",
      shardId: "0xabc123@7",
      operatorUrl: "https://operator.example.com",
    });

    expect(url).toContain("https://example.com/play?");
    expect(url).toContain("shard_rpc=");
    expect(url).toContain("shard_torii=");
    expect(url).toContain("shard_id=");
    expect(url).toContain("shard_operator=");
  });
});
