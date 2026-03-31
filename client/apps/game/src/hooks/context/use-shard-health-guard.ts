/**
 * Monitors shard liveness during gameplay via the operator status API.
 *
 * When a shard enters a terminal phase (failed, completed, suspended) or
 * becomes unreachable, the guard clears shard mode and navigates back to
 * the main world. This prevents the player from being stuck on a 502 screen
 * when the shard VM is destroyed during gameplay.
 *
 * Protocol-first: uses the operator's structured protocol status as the
 * single source of truth for shard health — not RPC error guessing.
 */
import { useEffect, useRef } from "react";
import { useShardStore } from "@/hooks/store/use-shard-store";
import {
  extractGameContractFromShardId,
  parseShardStatusEntriesFromStatusResponse,
  isRecoverableProtocolPhase,
} from "@/sharding/protocol";

const HEALTH_POLL_INTERVAL_MS = 15_000;
const CONSECUTIVE_FAILURES_THRESHOLD = 3;

export const useShardHealthGuard = () => {
  const isShardMode = useShardStore((s) => s.isShardMode);
  const operatorUrl = useShardStore((s) => s.operatorUrl);
  const shardId = useShardStore((s) => s.shardId);
  const mainGameReturnUrl = useShardStore((s) => s.mainGameReturnUrl);
  const clearShardMode = useShardStore((s) => s.clearShardMode);

  const consecutiveFailuresRef = useRef(0);

  useEffect(() => {
    if (!isShardMode || !operatorUrl || !shardId) {
      consecutiveFailuresRef.current = 0;
      return;
    }

    let cancelled = false;
    let gameContractAddress: string;
    try {
      gameContractAddress = extractGameContractFromShardId(shardId);
    } catch {
      console.warn("[shard-health-guard] Cannot parse shard ID, skipping health checks:", shardId);
      return;
    }

    const checkHealth = async () => {
      if (cancelled) return;

      try {
        const response = await fetch(`${operatorUrl}/shard/${gameContractAddress}`);
        if (cancelled) return;

        if (!response.ok) {
          consecutiveFailuresRef.current += 1;
          console.warn(
            `[shard-health-guard] Operator returned HTTP ${response.status} (${consecutiveFailuresRef.current}/${CONSECUTIVE_FAILURES_THRESHOLD})`,
          );
          if (consecutiveFailuresRef.current >= CONSECUTIVE_FAILURES_THRESHOLD) {
            handleShardGone("operator_unreachable");
          }
          return;
        }

        const payload: unknown = await response.json();
        if (cancelled) return;

        const entries = parseShardStatusEntriesFromStatusResponse(payload);
        const ourShard = entries.find((e) => e.shardId === shardId);

        if (!ourShard) {
          consecutiveFailuresRef.current += 1;
          console.warn(
            `[shard-health-guard] Shard ${shardId} not found in operator status (${consecutiveFailuresRef.current}/${CONSECUTIVE_FAILURES_THRESHOLD})`,
          );
          if (consecutiveFailuresRef.current >= CONSECUTIVE_FAILURES_THRESHOLD) {
            handleShardGone("shard_not_found");
          }
          return;
        }

        // Shard found — check protocol phase.
        consecutiveFailuresRef.current = 0;

        if (!isRecoverableProtocolPhase(ourShard.protocol)) {
          console.warn(
            `[shard-health-guard] Shard ${shardId} entered terminal phase: ${ourShard.protocol.phase}`,
          );
          handleShardGone(`terminal_phase:${ourShard.protocol.phase}`);
        }
      } catch (error) {
        if (cancelled) return;
        consecutiveFailuresRef.current += 1;
        console.warn(
          `[shard-health-guard] Health check failed (${consecutiveFailuresRef.current}/${CONSECUTIVE_FAILURES_THRESHOLD}):`,
          error,
        );
        if (consecutiveFailuresRef.current >= CONSECUTIVE_FAILURES_THRESHOLD) {
          handleShardGone("network_error");
        }
      }
    };

    const handleShardGone = (reason: string) => {
      if (cancelled) return;
      cancelled = true;

      console.error(`[shard-health-guard] Exiting shard mode: ${reason}`);
      clearShardMode();

      if (typeof window !== "undefined") {
        const returnUrl = mainGameReturnUrl ?? "/";
        const separator = returnUrl.includes("?") ? "&" : "?";
        window.location.assign(`${returnUrl}${separator}shard_return=1&shard_exit_reason=${reason}`);
      }
    };

    // Start polling immediately, then every HEALTH_POLL_INTERVAL_MS.
    checkHealth();
    const intervalId = window.setInterval(checkHealth, HEALTH_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isShardMode, operatorUrl, shardId, mainGameReturnUrl, clearShardMode]);
};
