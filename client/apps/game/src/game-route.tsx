/**
 * Game route module - lazy loaded to avoid pulling heavy deps (World, Dojo, Three.js, etc.)
 * into the landing page bundle.
 */
import { ErrorBoundary, Toaster, TransactionNotification, WorldLoading } from "@/ui/shared";
import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import type { Account, AccountInterface } from "starknet";
import { env } from "../env";
import { DojoProvider } from "./hooks/context/dojo-context";
import { useUnifiedOnboarding } from "./hooks/context/use-unified-onboarding";
import { useTransactionListener } from "./hooks/use-transaction-listener";
import type { SetupResult } from "./init/bootstrap";
import { StoryEventToastBridge } from "./ui/features/story-events";
import { LoadingScreen } from "./ui/modules/loading-screen";
import { World } from "./ui/layouts/world";
import { resolveGameRouteView } from "./game-route.utils";
import { resolveRuntimeContextFromWindow } from "./sharding/runtime-context";

type ReadyAppProps = {
  backgroundImage: string;
  setupResult: SetupResult;
  account: Account | AccountInterface;
};

const TransactionListenerBridge = () => {
  useTransactionListener();
  return null;
};

const ReadyApp = ({ backgroundImage, setupResult, account }: ReadyAppProps) => {
  return (
    <DojoProvider value={setupResult} account={account}>
      <ErrorBoundary>
        <StoryEventToastBridge />
        <TransactionListenerBridge />
        <TransactionNotification />
        <World backgroundImage={backgroundImage} />
        <WorldLoading />
        <Toaster />
      </ErrorBoundary>
    </DojoProvider>
  );
};

export const GameRoute = ({ backgroundImage }: { backgroundImage: string }) => {
  useEffect(() => {
    if (!env.VITE_TRACING_ENABLED) {
      return;
    }

    let cancelled = false;
    let cleanup: (() => void) | undefined;

    const setupTracing = async () => {
      const { initializeTracing, cleanupTracing } = await import("./tracing");
      if (cancelled) return;
      initializeTracing({ enableMetricsCollection: false });
      cleanup = () => {
        void cleanupTracing();
      };
    };

    void setupTracing();

    return () => {
      cancelled = true;
      if (cleanup) {
        cleanup();
      }
    };
  }, []);

  const state = useUnifiedOnboarding(backgroundImage);
  const { phase, setupResult, account } = state;
  const hasShardContext =
    typeof window !== "undefined" &&
    (() => {
      try {
        return resolveRuntimeContextFromWindow().kind === "shard";
      } catch (error) {
        console.error("[GameRoute] Failed to resolve runtime context from URL", error);
        return false;
      }
    })();
  const hasShardReturnPending =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("shard_return") === "1";
  const routeView = resolveGameRouteView({
    phase,
    hasSetupResult: setupResult !== null,
    hasAccount: account !== null,
    hasShardContext,
    hasShardReturnPending,
  });

  useEffect(() => {
    if (!hasShardReturnPending || typeof window === "undefined") {
      return;
    }

    const clearShardReturnFlag = () => {
      const url = new URL(window.location.href);
      url.searchParams.delete("shard_return");
      const nextRelativeUrl = url.pathname + url.search + url.hash;
      window.history.replaceState({}, "", nextRelativeUrl);
    };

    if (routeView === "ready") {
      clearShardReturnFlag();
    }
  }, [hasShardReturnPending, routeView]);

  if (routeView === "redirect") {
    return <Navigate to="/" replace />;
  }

  if (routeView === "loading") {
    return <LoadingScreen />;
  }

  if (!setupResult || !account) {
    return <LoadingScreen />;
  }

  return <ReadyApp backgroundImage={backgroundImage} setupResult={setupResult} account={account} />;
};
