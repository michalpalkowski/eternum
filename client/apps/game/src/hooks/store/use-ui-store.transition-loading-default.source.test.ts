import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("UI store transition loading default", () => {
  it("starts with transition loading disabled", () => {
    const source = readFileSync(resolve(process.cwd(), "src/hooks/store/use-ui-store.ts"), "utf8");

    expect(source).toContain("isLoadingScreenEnabled: false");
  });
});
