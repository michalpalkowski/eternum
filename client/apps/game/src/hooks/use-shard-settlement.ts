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
export type ShardSettlementErrorCode =
  | "MISSING_ACCOUNT"
  | "MISSING_OPERATOR_URL"
  | "MISSING_SHARD_ID"
  | "STREAM_PAYLOAD_INVALID"
  | "STREAM_DISCONNECTED"
  | "SETTLEMENT_TX_FAILED";

interface UseShardSettlementParams {
  account: ExecutableAccount | null;
  shardId: string | null;
  operatorUrl: string | null;
}

export const useShardSettlement = ({ account, shardId, operatorUrl }: UseShardSettlementParams) => {
  const [phase, setPhase] = useState<ShardSettlementPhase>("idle");
  const [stepLabel, setStepLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<ShardSettlementErrorCode | null>(null);

  const reset = useCallback(() => {
    setPhase("idle");
    setStepLabel(null);
    setErrorCode(null);
    setError(null);
  }, []);

  const failSettlement = useCallback((code: ShardSettlementErrorCode, message: string) => {
    setErrorCode(code);
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
      failSettlement("STREAM_PAYLOAD_INVALID", message);
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
          if (parsed.shardId !== shardId) {
            return;
          }
          setStepLabel(parsed.type === "settling" ? parsed.stepLabel : null);
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : "Invalid settling event payload";
          failAndClose(message);
        }
      });

      eventSource.addEventListener("completed", (event) => {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          failAndClose("Invalid completed event payload");
          return;
        }

        try {
          const parsed = parseSettlementStreamEvent("completed", event.data);
          if (parsed.shardId !== shardId) {
            return;
          }
          closeStream();
          setPhase("complete");
          setErrorCode(null);
          setError(null);
          setStepLabel(null);
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : "Invalid completed event payload";
          failAndClose(message);
        }
      });

      eventSource.addEventListener("failed", (event) => {
        if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
          failAndClose("Invalid failed event payload");
          return;
        }

        try {
          const parsed = parseSettlementStreamEvent("failed", event.data);
          if (parsed.shardId !== shardId) {
            return;
          }
          if (parsed.type !== "failed") {
            failAndClose("Unexpected failed event payload");
            return;
          }
          closeStream();
          failSettlement("STREAM_PAYLOAD_INVALID", parsed.reason);
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : "Invalid failed event payload";
          failAndClose(message);
        }
      });

      eventSource.onerror = () => {
        closeStream();
        failSettlement("STREAM_DISCONNECTED", "Settlement event stream disconnected");
      };
    } catch (streamError) {
      const message = streamError instanceof Error ? streamError.message : "Failed to start settlement stream";
      failSettlement("STREAM_PAYLOAD_INVALID", message);
    }

    return closeStream;
  }, [failSettlement, operatorUrl, phase, shardId]);

  const startSettlement = useCallback(async () => {
    if (phase === "waiting" || phase === "calling") {
      return;
    }
    if (account === null) {
      failSettlement("MISSING_ACCOUNT", "Wallet account is required to settle a shard");
      return;
    }
    if (operatorUrl === null) {
      failSettlement("MISSING_OPERATOR_URL", "Missing shard operator URL");
      return;
    }
    if (shardId === null) {
      failSettlement("MISSING_SHARD_ID", "Missing shard ID");
      return;
    }

    setPhase("calling");
    setErrorCode(null);
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
      failSettlement("SETTLEMENT_TX_FAILED", message);
    }
  }, [account, failSettlement, operatorUrl, phase, shardId]);

  return {
    phase,
    errorCode,
    stepLabel,
    error,
    startSettlement,
    reset,
  };
};
