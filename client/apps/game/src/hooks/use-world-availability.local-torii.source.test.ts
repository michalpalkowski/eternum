import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("world availability local torii routing", () => {
  it("uses the local Torii endpoint for local worlds", () => {
    const source = readFileSync(resolve(process.cwd(), "src/hooks/use-world-availability.ts"), "utf8");

    expect(source).toContain("isLocalWorldChain");
    expect(source).toContain("isLocalWorldEnvironment");
    expect(source).toContain("return env.VITE_PUBLIC_TORII");
    expect(source).toContain("if (isLocalWorldChain(chain)) return null;");
  });
});
