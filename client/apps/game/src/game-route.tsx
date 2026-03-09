/**
 * Game route module - lazy loaded to avoid pulling heavy deps (World, Dojo, Three.js, etc.)
 * into the landing page bundle.
 */
import { ErrorBoundary, Toaster, TransactionNotification, WorldLoading } from "@/ui/shared";
import { useEffect, useState } from "react";
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

const SHARD_RETURN_LOADING_GRACE_MS = 15_000;
const SHARD_RETURN_FAILURE_REDIRECT_MS = 2_500;

const ShardReturnFailureScreen = () => (
  <div className="min-h-screen flex items-center justify-center bg-black px-6">
    <div className="max-w-md text-center space-y-2">
      <p className="text-sm font-semibold uppercase tracking-wider text-gold">Shard Return Failed</p>
      <p className="text-xs text-gold/70">
        Could not reconnect this tab to the main world. Redirecting to landing page.
      </p>
    </div>
  </div>
);

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
  const { phase, setupResult, account, isConnecting, bootstrap } = state;
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
  const [shardReturnGraceExpired, setShardReturnGraceExpired] = useState(false);

  useEffect(() => {
    if (!hasShardReturnPending) {
      setShardReturnGraceExpired(false);
      return;
    }

    setShardReturnGraceExpired(false);
    const timer = window.setTimeout(() => {
      setShardReturnGraceExpired(true);
    }, SHARD_RETURN_LOADING_GRACE_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [hasShardReturnPending]);

  const allowShardReturnLoading =
    hasShardReturnPending &&
    !shardReturnGraceExpired &&
    (isConnecting || (bootstrap.status !== "ready" && bootstrap.status !== "error"));
  const hasShardReturnFailure =
    hasShardReturnPending && shardReturnGraceExpired && (setupResult === null || account === null);

  const routeView = resolveGameRouteView({
    phase,
    hasSetupResult: setupResult !== null,
    hasAccount: account !== null,
    hasShardContext,
    hasShardReturnPending,
    allowShardReturnLoading,
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

    if (routeView !== "loading" || shardReturnGraceExpired) {
      clearShardReturnFlag();
    }
  }, [hasShardReturnPending, routeView, shardReturnGraceExpired]);

  useEffect(() => {
    if (!hasShardReturnFailure || typeof window === "undefined") {
      return;
    }

    const timer = window.setTimeout(() => {
      const url = new URL("/", window.location.origin);
      url.searchParams.set("shard_return_error", "bootstrap_timeout");
      window.location.assign(url.toString());
    }, SHARD_RETURN_FAILURE_REDIRECT_MS);

    return () => {
      window.clearTimeout(timer);
    };
  }, [hasShardReturnFailure]);

  if (hasShardReturnFailure) {
    return <ShardReturnFailureScreen />;
  }

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
