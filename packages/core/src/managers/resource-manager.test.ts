import { afterEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_PRECISION, ResourcesIds } from "@bibliothecadao/types";
import { getBalance } from "../utils/resources";

vi.mock("@dojoengine/recs", () => ({
  getComponentValue: (component: unknown, entity: unknown) => {
    if (component instanceof Map) {
      return component.get(entity);
    }
    return undefined;
  },
  Has: (component: unknown) => component,
  runQuery: (clauses: unknown[]) => {
    const component = clauses[0];
    if (component instanceof Map) {
      return new Set(component.keys());
    }
    return new Set();
  },
}));

vi.mock("@dojoengine/utils", () => ({
  getEntityIdFromKeys: (keys: Array<bigint | number>) => `direct:${keys.map((key) => BigInt(key).toString()).join(":")}`,
}));

describe("ResourceManager", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads hydrated Resource balances when direct entity lookup misses", () => {
    const components = {
      Resource: new Map([
        [
          "hydrated:Resource:165",
          {
            entity_id: 165,
            WOOD_BALANCE: BigInt(20 * RESOURCE_PRECISION),
            WOOD_PRODUCTION: {
              building_count: 0,
              production_rate: 0n,
              output_amount_left: 0n,
              last_updated_at: 0,
            },
            weight: {
              capacity: 0n,
              weight: 0n,
            },
          },
        ],
      ]),
      StructureBuildings: new Map(),
    } as any;

    expect(getBalance(165, ResourcesIds.Wood, 0, components).balance).toBe(20 * RESOURCE_PRECISION);
  });
});
