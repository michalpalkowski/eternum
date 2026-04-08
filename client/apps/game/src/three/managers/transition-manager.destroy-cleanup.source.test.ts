import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("TransitionManager destroy cleanup", () => {
  it("releases global transition overlay state during teardown", () => {
    const source = readFileSync(resolve(process.cwd(), "src/three/managers/transition-manager.tsx"), "utf8");

    expect(source).toContain("destroy()");
    expect(source).toContain("setIsLoadingScreenEnabled(false)");
    expect(source).toContain("setTooltip(null)");
  });
});
