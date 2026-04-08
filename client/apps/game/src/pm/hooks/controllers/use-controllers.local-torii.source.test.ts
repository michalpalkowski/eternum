import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("controllers fetch local torii guard", () => {
  it("skips remote controller fetches in local worlds", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pm/hooks/controllers/use-controllers.tsx"), "utf8");

    expect(source).toContain("isLocalWorldEnvironment");
    expect(source).toContain("shouldSkipControllersFetch");
    expect(source).toContain("setControllers([])");
  });
});
