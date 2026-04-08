import { afterEach, describe, expect, it, vi } from "vitest";
import { RESOURCE_PRECISION, ResourcesIds } from "@bibliothecadao/types";
import { getBuildingCosts } from "./buildings";

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
  getEntityIdFromKeys: (keys: Array<bigint | number>) =>
    `direct:${keys.map((key) => BigInt(key).toString()).join(":")}`,
}));

describe("getBuildingCosts", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates building costs from scanned ResourceList entries when direct keys miss", () => {
    const components = {
      StructureBuildings: new Map([
        [
          "hydrated:StructureBuildings:165",
          {
            entity_id: 165,
            packed_counts_1: 0n,
            packed_counts_2: 0n,
            packed_counts_3: 0n,
          },
        ],
      ]),
      BuildingCategoryConfig: new Map([
        [
          "direct:1",
          {
            category: 1,
            simple_erection_cost_id: 82,
            simple_erection_cost_count: 1,
            complex_erection_cost_id: 0,
            complex_erection_cost_count: 0,
          },
        ],
      ]),
      ResourceList: new Map([
        [
          "hydrated:ResourceList:82:0",
          {
            entity_id: 82,
            index: 0,
            resource_type: ResourcesIds.Wood,
            amount: BigInt(20 * RESOURCE_PRECISION),
          },
        ],
      ]),
    } as any;

    expect(getBuildingCosts(165, components, 1 as any, true)).toEqual([{ resource: ResourcesIds.Wood, amount: 20 }]);
  });
});
