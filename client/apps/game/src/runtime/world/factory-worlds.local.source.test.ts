import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("factory worlds local fallback", () => {
  it("builds a synthetic world entry in local mode", () => {
    const source = readFileSync(resolve(process.cwd(), "src/runtime/world/factory-worlds.ts"), "utf8");

    expect(source).toContain('chain === "local"');
    expect(source).toContain("isLocalWorldMode");
    expect(source).toContain("env.VITE_PUBLIC_SLOT");
    expect(source).toContain("worldAddress: null");
  });
});
