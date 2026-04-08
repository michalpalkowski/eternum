// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  createPlayEntryAssetPrimer,
  createPlayEntryRoutePrimer,
  resolveGameRouteLazyModule,
} from "./game-entry-preload";

type GameRouteDefaultExport = typeof import("./game-route").default;
const createRouteComponent = (): GameRouteDefaultExport =>
  (({ backgroundImage }: { backgroundImage: string }) => {
    void backgroundImage;
    return {} as JSX.Element;
  }) as GameRouteDefaultExport;

describe("createPlayEntryRoutePrimer", () => {
  it("schedules the game route preload without touching play assets", async () => {
    vi.useFakeTimers();
    const routeComponent = createRouteComponent();
    const preloadGameRouteModule = vi.fn<() => Promise<{ default: GameRouteDefaultExport }>>(async () => ({
      default: routeComponent,
    }));
    const prefetchPlayAssets = vi.fn();

    createPlayEntryRoutePrimer({
      preloadGameRouteModule,
    })();

    expect(preloadGameRouteModule).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(preloadGameRouteModule).toHaveBeenCalledTimes(1);
    expect(prefetchPlayAssets).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("resolveGameRouteLazyModule", () => {
  it("prefers default export when provided", () => {
    const DefaultRoute = createRouteComponent();
    const resolved = resolveGameRouteLazyModule({
      default: DefaultRoute,
      GameRoute: createRouteComponent(),
    } as unknown as typeof import("./game-route"));

    expect(resolved.default).toBe(DefaultRoute);
  });

  it("falls back to named GameRoute export when default is missing", () => {
    const NamedRoute = createRouteComponent();
    const resolved = resolveGameRouteLazyModule({
      default: undefined,
      GameRoute: NamedRoute,
    } as unknown as typeof import("./game-route"));

    expect(resolved.default).toBe(NamedRoute);
  });
});

describe("createPlayEntryAssetPrimer", () => {
  it("schedules the play asset prefetch independently of route preloading", async () => {
    vi.useFakeTimers();
    const prefetchPlayAssets = vi.fn();

    createPlayEntryAssetPrimer({
      prefetchPlayAssets,
    })();

    expect(prefetchPlayAssets).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    expect(prefetchPlayAssets).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
