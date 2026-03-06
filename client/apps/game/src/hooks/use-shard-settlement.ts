import { getContractByName } from "@dojoengine/core";
import { useCallback, useEffect, useState } from "react";
import type { Call } from "starknet";
import { dojoConfig } from "../../dojo-config";
import {
  extractGameContractFromShardId,
  parseSettlementStreamEvent,
} from "@/sharding/protocol";
import type { ExecutableAccount } from "@/sharding/types";

export type ShardSettlementPhase = "idle" | "calling" | "waiting" | "complete" | "error";

interface UseShardSettlementParams {
  account: ExecutableAccount | null;
  shardId: string | null;
  operatorUrl: string | null;
}

export const useShardSettlement = ({ account, shardId, operatorUrl }: UseShardSettlementParams) => {
  const [phase, setPhase] = useState<ShardSettlementPhase>("idle");
  const [stepLabel, setStepLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setStepLabel(null);
    setError(null);
  }, []);

  const failSettlement = useCallback((message: string) => {
    setError(message);
    setStepLabel(null);
    setPhase("error");
  }, []);

  useEffect(() => {
    if (phase !== "waiting" || operatorUrl === null || shardId === null) {
      return;
    }

    let eventSource: EventSource | null = null;
    const closeStream = () => {
      if (eventSource !== null) {
        eventSource.close();
      }
    };

    const failAndClose = (message: string) => {
      closeStream();
      failSettlement(message);
    };

    try {
      const gameContractAddress = extractGameContractFromShardId(shardId);
      eventSource = new EventSource(`${operatorUrl}/shard/${gameContractAddress}/events`);

      eventSource.addEventListener("settling", (event) => {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          failAndClose("Invalid settling event payload");
          return;
        }

        try {
          const parsed = parseSettlementStreamEvent("settling", event.data);
          setStepLabel(parsed.type === "settling" ? parsed.stepLabel : null);
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : "Invalid settling event payload";
          failAndClose(message);
        }
      });

      eventSource.addEventListener("completed", () => {
        closeStream();
        setPhase("complete");
        setError(null);
        setStepLabel(null);
      });

      eventSource.addEventListener("failed", (event) => {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          failAndClose("Invalid failed event payload");
          return;
        }

        try {
          const parsed = parseSettlementStreamEvent("failed", event.data);
          if (parsed.type !== "failed") {
            failAndClose("Unexpected failed event payload");
            return;
          }
          failAndClose(parsed.reason);
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : "Invalid failed event payload";
          failAndClose(message);
        }
      });

      eventSource.onerror = () => {
        failAndClose("Settlement event stream disconnected");
      };
    } catch (streamError) {
      const message = streamError instanceof Error ? streamError.message : "Failed to start settlement stream";
      failAndClose(message);
    }

    return closeStream;
  }, [failSettlement, operatorUrl, phase, shardId]);

  const startSettlement = useCallback(async () => {
    if (phase === "waiting" || phase === "calling") {
      return;
    }
    if (account === null) {
      failSettlement("Wallet account is required to settle a shard");
      return;
    }
    if (operatorUrl === null) {
      failSettlement("Missing shard operator URL");
      return;
    }
    if (shardId === null) {
      failSettlement("Missing shard ID");
      return;
    }

    setPhase("calling");
    setError(null);
    setStepLabel(null);

    try {
      const shardingContract = getContractByName(dojoConfig.manifest, "s1_eternum", "sharding_systems");
      const finishShardCall: Call = {
        contractAddress: shardingContract.address,
        entrypoint: "finish_shard",
        calldata: [],
      };
      await account.execute([finishShardCall]);
      setPhase("waiting");
    } catch (settlementError) {
      const message = settlementError instanceof Error ? settlementError.message : "finish_shard transaction failed";
      failSettlement(message);
    }
  }, [account, failSettlement, operatorUrl, phase, shardId]);

  return {
    phase,
    stepLabel,
    error,
    startSettlement,
    reset,
  };
};
