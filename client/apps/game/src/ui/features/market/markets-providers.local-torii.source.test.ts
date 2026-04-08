import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("MarketsProviders local torii resolution", () => {
  it("routes local worlds through the resolved local/global Torii policy before chain defaults", () => {
    const source = readFileSync(resolve(process.cwd(), "src/ui/features/market/markets-providers.tsx"), "utf8");

    expect(source).toContain("resolveGlobalToriiUrl");
    expect(source).toContain("isLocalWorldEnvironment");
    expect(source).toContain("if (isLocalWorld)");
    expect(source).toContain("return resolveGlobalToriiUrl()");
    expect(source).toContain("hasExplicitGlobalToriiUrl");
    expect(source).toContain("return env.VITE_PUBLIC_GLOBAL_TORII");
  });
});
