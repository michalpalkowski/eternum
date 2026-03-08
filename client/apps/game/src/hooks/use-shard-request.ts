import { getContractByName } from "@dojoengine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Call } from "starknet";
import { dojoConfig } from "../../dojo-config";
import {
  buildShardPlayUrl,
  parseActiveShardFromStatusResponse,
  parseOperatorConfigResponse,
  parseShardIdParts,
  parseTransportHealthFromStatusResponse,
} from "@/sharding/protocol";
import type { ExecutableAccount } from "@/sharding/types";

export type ShardRequestPhase = "idle" | "requesting" | "waiting" | "ready" | "error";

interface ShardUrls {
  katanaUrl: string;
  toriiUrl: string;
  toriiGrpcUrl: string | null;
  gameContractAddress: string;
  shardId: string;
}

export const useShardRequest = (account: ExecutableAccount | null, operatorUrl: string) => {
  const [phase, setPhase] = useState<ShardRequestPhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [shardUrls, setShardUrls] = useState<ShardUrls | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const failRequest = useCallback(
    (message: string) => {
      stopPolling();
      setError(message);
      setPhase("error");
    },
    [stopPolling],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const requestShard = useCallback(
    async (entityIds: number[]) => {
      if (phase !== "idle") {
        return;
      }
      if (account === null) {
        failRequest("Wallet account is required to request a shard");
        return;
      }
      if (entityIds.length === 0) {
        failRequest("entityIds must not be empty");
        return;
      }

      setPhase("requesting");
      setError(null);
      setShardUrls(null);

      try {
        const configResponse = await fetch(`${operatorUrl}/config`);
        if (!configResponse.ok) {
          throw new Error(`Failed to fetch operator config: HTTP ${configResponse.status}`);
        }
        const configPayload: unknown = await configResponse.json();
        const operatorConfig = parseOperatorConfigResponse(configPayload);

        const shardingContract = getContractByName(dojoConfig.manifest, "s1_eternum", "sharding_systems");
        const requestShardCall: Call = {
          contractAddress: shardingContract.address,
          entrypoint: "request_shard_all",
          calldata: [
            operatorConfig.shardContractAddress,
            entityIds.length.toString(),
            ...entityIds.map((entityId) => entityId.toString()),
          ],
        };
        await account.execute([requestShardCall]);

        setPhase("waiting");
        const worldAddress = dojoConfig.manifest.world.address;
        pollRef.current = setInterval(() => {
          void (async () => {
            try {
              const statusResponse = await fetch(`${operatorUrl}/shard/${worldAddress}`);
              if (!statusResponse.ok) {
                throw new Error(`Failed to fetch shard status: HTTP ${statusResponse.status}`);
              }
              const statusPayload: unknown = await statusResponse.json();
              const activeShard = parseActiveShardFromStatusResponse(statusPayload);
              if (activeShard === null) {
                return;
              }

              const { gameContractAddress, onchainShardId } = parseShardIdParts(activeShard.shardId);

              const transportResponse = await fetch(
                `${operatorUrl}/shard/${gameContractAddress}/${onchainShardId}/transport-health`,
              );
              if (!transportResponse.ok) {
                throw new Error(`Failed to fetch shard transport health: HTTP ${transportResponse.status}`);
              }
              const transportPayload: unknown = await transportResponse.json();
              const transport = parseTransportHealthFromStatusResponse(transportPayload);
              if (transport.status !== "healthy") {
                return;
              }

              stopPolling();
              setShardUrls({
                katanaUrl: activeShard.katanaUrl,
                toriiUrl: activeShard.toriiUrl,
                toriiGrpcUrl: activeShard.toriiGrpcUrl,
                gameContractAddress: activeShard.gameContractAddress,
                shardId: activeShard.shardId,
              });
              setPhase("ready");
            } catch (pollError) {
              const message = pollError instanceof Error ? pollError.message : "Failed to poll shard status";
              failRequest(message);
            }
          })();
        }, 2000);
      } catch (requestError) {
        const message = requestError instanceof Error ? requestError.message : "Shard request failed";
        failRequest(message);
      }
    },
    [account, failRequest, operatorUrl, phase, stopPolling],
  );

  const openShardTab = useCallback(() => {
    if (phase !== "ready" || shardUrls === null) {
      return;
    }

    const shardUrl = buildShardPlayUrl(window.location.origin, {
      rpcUrl: shardUrls.katanaUrl,
      toriiUrl: shardUrls.toriiUrl,
      toriiGrpcUrl: shardUrls.toriiGrpcUrl ?? shardUrls.toriiUrl,
      shardId: shardUrls.shardId,
      operatorUrl,
      mainUrl: window.location.href,
    });
    window.location.assign(shardUrl);
  }, [operatorUrl, phase, shardUrls]);

  const reset = useCallback(() => {
    stopPolling();
    setPhase("idle");
    setError(null);
    setShardUrls(null);
  }, [stopPolling]);

  return {
    phase,
    error,
    shardUrls,
    requestShard,
    openShardTab,
    reset,
  };
};
