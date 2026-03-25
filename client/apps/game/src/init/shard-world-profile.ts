import type { Chain } from "@contracts";
import {
  buildWorldProfile,
  getFactorySqlBaseUrl,
  resolveWorldNameFromFactory,
  type WorldProfile,
} from "@/runtime/world";
import { parseShardIdParts } from "@/sharding/protocol";
import { normalizeHexAddress } from "@/sharding/addresses";

export const resolveProfileForShardSession = async (params: {
  chain: Chain;
  profile: WorldProfile;
  shardId: string;
}): Promise<WorldProfile> => {
  const { chain, profile, shardId } = params;
  const { gameContractAddress } = parseShardIdParts(shardId);
  const normalizedProfileWorldAddress = normalizeHexAddress(profile.worldAddress);
  const normalizedShardWorldAddress = normalizeHexAddress(gameContractAddress);

  if (
    normalizedProfileWorldAddress !== null &&
    normalizedShardWorldAddress !== null &&
    normalizedProfileWorldAddress === normalizedShardWorldAddress
  ) {
    return profile;
  }

  const isLocalWorld = import.meta.env.VITE_PUBLIC_LOCAL_WORLD === "true";
  if (chain === "local" || isLocalWorld) {
    console.warn("[bootstrap] Shard session world differs from active local profile; forcing manifest world address", {
      activeWorldName: profile.name,
      activeWorldAddress: profile.worldAddress,
      shardWorldAddress: normalizedShardWorldAddress ?? gameContractAddress,
    });

    return {
      ...profile,
      worldAddress: normalizedShardWorldAddress ?? gameContractAddress,
    };
  }

  const factorySqlBaseUrl = getFactorySqlBaseUrl(chain);
  const shardWorldName = await resolveWorldNameFromFactory(
    factorySqlBaseUrl,
    normalizedShardWorldAddress ?? gameContractAddress,
  );
  if (!shardWorldName) {
    throw new Error(
      `[bootstrap] Shard session targets world ${
        normalizedShardWorldAddress ?? gameContractAddress
      }, but active profile '${profile.name}' resolves to ${profile.worldAddress}; factory could not map that shard world address back to a world name`,
    );
  }

  const shardProfile = await buildWorldProfile(chain, shardWorldName);
  const normalizedShardProfileWorldAddress = normalizeHexAddress(shardProfile.worldAddress);
  if (normalizedShardProfileWorldAddress !== (normalizedShardWorldAddress ?? gameContractAddress)) {
    throw new Error(
      `[bootstrap] Factory resolved shard world '${shardWorldName}', but its world address is ${shardProfile.worldAddress} instead of ${gameContractAddress}`,
    );
  }

  console.warn("[bootstrap] Aligned shard bootstrap profile with shard session world", {
    previousWorldName: profile.name,
    previousWorldAddress: profile.worldAddress,
    shardWorldName,
    shardWorldAddress: gameContractAddress,
  });

  return shardProfile;
};
