import { prefetchPlayAssets } from "@/ui/utils/prefetch-play-assets";

type GameRouteModule = typeof import("./game-route");
type GameRouteLazyModule = Pick<GameRouteModule, "default">;

export const resolveGameRouteLazyModule = (module: GameRouteModule): GameRouteLazyModule => {
  if (typeof module.default === "function") {
    return { default: module.default };
  }

  const moduleWithNamedRoute = module as GameRouteModule & {
    GameRoute?: GameRouteModule["default"];
  };
  if (typeof moduleWithNamedRoute.GameRoute === "function") {
    return { default: moduleWithNamedRoute.GameRoute };
  }

  throw new Error("Game route module must export a default component compatible with React.lazy");
};

export const createPlayEntryRoutePrimer = ({
  preloadGameRouteModule,
}: {
  preloadGameRouteModule: () => Promise<GameRouteLazyModule>;
}) => {
  return () => {
    const idleCallback = (
      globalThis as typeof globalThis & {
        requestIdleCallback?: (fn: () => void) => number;
      }
    ).requestIdleCallback;

    if (typeof idleCallback === "function") {
      idleCallback(() => {
        void preloadGameRouteModule();
      });
      return;
    }

    globalThis.setTimeout(() => {
      void preloadGameRouteModule();
    }, 0);
  };
};

export const createPlayEntryAssetPrimer = ({ prefetchPlayAssets }: { prefetchPlayAssets: () => void }) => {
  return () => {
    const idleCallback = (
      globalThis as typeof globalThis & {
        requestIdleCallback?: (fn: () => void) => number;
      }
    ).requestIdleCallback;

    if (typeof idleCallback === "function") {
      idleCallback(() => {
        prefetchPlayAssets();
      });
      return;
    }

    globalThis.setTimeout(() => {
      prefetchPlayAssets();
    }, 0);
  };
};

let gameRoutePreloadPromise: Promise<GameRouteLazyModule> | null = null;

export const preloadGameRouteModule = (): Promise<GameRouteLazyModule> => {
  if (!gameRoutePreloadPromise) {
    gameRoutePreloadPromise = import("./game-route").then(resolveGameRouteLazyModule);
  }

  return gameRoutePreloadPromise;
};

export const primePlayEntryRoute = createPlayEntryRoutePrimer({
  preloadGameRouteModule,
});

export const primePlayEntryAssets = createPlayEntryAssetPrimer({
  prefetchPlayAssets,
});
