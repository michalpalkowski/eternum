import type { OnboardingPhase } from "@/hooks/context/use-unified-onboarding";

type GameRouteView = "loading" | "ready" | "redirect";

const REQUIRES_LANDING_PHASES: ReadonlySet<OnboardingPhase> = new Set(["world-select", "account", "avatar"]);

export const resolveGameRouteView = ({
  phase,
  hasSetupResult,
  hasAccount,
  hasShardContext = false,
  hasShardReturnPending = false,
}: {
  phase: OnboardingPhase;
  hasSetupResult: boolean;
  hasAccount: boolean;
  hasShardContext?: boolean;
  hasShardReturnPending?: boolean;
}): GameRouteView => {
  if (hasSetupResult && hasAccount) {
    return "ready";
  }

  // Shard tabs carry session context in URL query params. Redirecting to landing
  // would drop that context and boot the player back into main-world mode.
  if (hasShardContext || hasShardReturnPending) {
    return "loading";
  }

  if (REQUIRES_LANDING_PHASES.has(phase)) {
    return "redirect";
  }

  return "loading";
};
