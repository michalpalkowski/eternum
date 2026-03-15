// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldProfile } from "@/runtime/world";
import { resolveProfileForShardSession } from "./shard-world-profile";

const mocks = vi.hoisted(() => ({
  buildWorldProfile: vi.fn(),
  getFactorySqlBaseUrl: vi.fn(),
  resolveWorldNameFromFactory: vi.fn(),
}));

vi.mock("@/runtime/world", () => ({
  buildWorldProfile: mocks.buildWorldProfile,
  getFactorySqlBaseUrl: mocks.getFactorySqlBaseUrl,
  resolveWorldNameFromFactory: mocks.resolveWorldNameFromFactory,
}));

const makeProfile = (overrides?: Partial<WorldProfile>): WorldProfile => ({
  name: "main-world",
  chain: "slot",
  toriiBaseUrl: "https://api.example/x/main-world/torii",
  rpcUrl: "https://api.example/x/main-world/katana",
  worldAddress: "0xaaa",
  contractsBySelector: {},
  fetchedAt: 1,
  ...overrides,
});

describe("resolveProfileForShardSession", () => {
  beforeEach(() => {
    mocks.buildWorldProfile.mockReset();
    mocks.getFactorySqlBaseUrl.mockReset();
    mocks.resolveWorldNameFromFactory.mockReset();
  });

  it("returns the active profile when shard world already matches", async () => {
    const profile = makeProfile({ worldAddress: "0xabc123" });

    await expect(
      resolveProfileForShardSession({
        chain: "slot",
        profile,
        shardId: "0xabc123@0x9",
      }),
    ).resolves.toBe(profile);

    expect(mocks.getFactorySqlBaseUrl).not.toHaveBeenCalled();
    expect(mocks.resolveWorldNameFromFactory).not.toHaveBeenCalled();
    expect(mocks.buildWorldProfile).not.toHaveBeenCalled();
  });

  it("forces local shard bootstrap to use the shard world address", async () => {
    const profile = makeProfile({
      chain: "local",
      worldAddress: "0x111",
      name: "dev",
      toriiBaseUrl: "http://localhost:8080",
      rpcUrl: "http://localhost:5050",
    });

    await expect(
      resolveProfileForShardSession({
        chain: "local",
        profile,
        shardId: "0xabc123@0x9",
      }),
    ).resolves.toEqual({
      ...profile,
      worldAddress: "0xabc123",
    });

    expect(mocks.getFactorySqlBaseUrl).not.toHaveBeenCalled();
    expect(mocks.resolveWorldNameFromFactory).not.toHaveBeenCalled();
    expect(mocks.buildWorldProfile).not.toHaveBeenCalled();
  });

  it("rebuilds the shard profile from factory when shard world differs", async () => {
    const profile = makeProfile({ worldAddress: "0x111" });
    const shardProfile = makeProfile({
      name: "shard-world",
      worldAddress: "0xabc123",
      toriiBaseUrl: "https://api.example/x/shard-world/torii",
    });
    mocks.getFactorySqlBaseUrl.mockReturnValue("https://factory.example/sql");
    mocks.resolveWorldNameFromFactory.mockResolvedValue("shard-world");
    mocks.buildWorldProfile.mockResolvedValue(shardProfile);

    await expect(
      resolveProfileForShardSession({
        chain: "slot",
        profile,
        shardId: "0xabc123@0x9",
      }),
    ).resolves.toBe(shardProfile);

    expect(mocks.getFactorySqlBaseUrl).toHaveBeenCalledWith("slot");
    expect(mocks.resolveWorldNameFromFactory).toHaveBeenCalledWith("https://factory.example/sql", "0xabc123");
    expect(mocks.buildWorldProfile).toHaveBeenCalledWith("slot", "shard-world");
  });

  it("throws when factory cannot map the shard world address back to a world name", async () => {
    mocks.getFactorySqlBaseUrl.mockReturnValue("https://factory.example/sql");
    mocks.resolveWorldNameFromFactory.mockResolvedValue(null);

    await expect(
      resolveProfileForShardSession({
        chain: "slot",
        profile: makeProfile({ worldAddress: "0x111" }),
        shardId: "0xabc123@0x9",
      }),
    ).rejects.toThrow(/could not map that shard world address back to a world name/i);

    expect(mocks.buildWorldProfile).not.toHaveBeenCalled();
  });
});
