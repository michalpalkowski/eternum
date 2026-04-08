import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("navigation transition loading ownership", () => {
  it("keeps transition loader control inside scene transitions", () => {
    const source = readFileSync(resolve(process.cwd(), "src/hooks/helpers/use-navigate.ts"), "utf8");

    expect(source).toContain("Scene transitions own the transition loader lifecycle.");
    expect(source).not.toContain("setIsLoadingScreenEnabled(true)");
  });
});
