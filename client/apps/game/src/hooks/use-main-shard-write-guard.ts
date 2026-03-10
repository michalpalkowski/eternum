import { useMemo } from "react";

import { useShardStore } from "@/hooks/store/use-shard-store";

const PHASE_REASONS = {
  requesting: "Shard request is being submitted. Wait until it finishes before changing the main realm.",
  waiting: "Shard is preparing. Open the shard when ready before changing the main realm.",
  ready: "Shard is ready. Open it before changing the main realm.",
} as const;

export const useMainShardWriteGuard = () => {
  const isShardMode = useShardStore((state) => state.isShardMode);
  const phase = useShardStore((state) => state.mainShardRequestPhase);
  const targetShardId = useShardStore((state) => state.mainShardTargetShardId);

  const isWriteBlocked = !isShardMode && (phase === "requesting" || phase === "waiting" || phase === "ready");

  const writeBlockReason = useMemo(() => {
    if (!isWriteBlocked) {
      return null;
    }

    return PHASE_REASONS[phase] ?? "Main-chain writes are blocked while a shard request is active.";
  }, [isWriteBlocked, phase]);

  return {
    isWriteBlocked,
    writeBlockReason,
    mainShardRequestPhase: phase,
    mainShardTargetShardId: targetShardId,
  };
};
