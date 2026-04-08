import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("GameRenderer transition overlay release", () => {
  it("always releases transition overlay after same-scene URL camera updates", () => {
    const source = readFileSync(resolve(process.cwd(), "src/three/game-renderer.ts"), "utf8");

    expect(source).toContain("Failed to move camera for active scene URL change");
    expect(source).toContain("finally {");
    expect(source).toContain("this.transitionManager?.fadeIn();");
  });
});
