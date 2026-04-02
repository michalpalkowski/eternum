import { describe, expect, it } from "vitest";
import { isDeletablePayloadForOrigin, isDeletionPayload } from "./sync-utils";

describe("sync-utils deletion semantics", () => {
  const emptyPayload = { models: {} };
  const upsertPayload = {
    models: {
      "s1_eternum-Structure": {
        entity_id: { value: 1 },
      },
    },
  };

  it("detects deletion-like payloads by shape", () => {
    expect(isDeletionPayload(emptyPayload)).toBe(true);
    expect(isDeletionPayload(upsertPayload)).toBe(false);
  });

  it("accepts deletions from entity stream", () => {
    expect(isDeletablePayloadForOrigin(emptyPayload, "entity")).toBe(true);
  });

  it("rejects deletion-like payloads from event stream", () => {
    expect(isDeletablePayloadForOrigin(emptyPayload, "event")).toBe(false);
  });

  it("keeps non-deletion updates as upserts regardless of origin", () => {
    expect(isDeletablePayloadForOrigin(upsertPayload, "entity")).toBe(false);
    expect(isDeletablePayloadForOrigin(upsertPayload, "event")).toBe(false);
  });
});
