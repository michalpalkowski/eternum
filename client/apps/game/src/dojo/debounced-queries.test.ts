import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./queries", () => ({
  getEntitiesFromTorii: vi.fn(),
  getOwnedArmiesFromTorii: vi.fn(),
  getBuildingsFromTorii: vi.fn(),
  getTilesForPositionsFromTorii: vi.fn(),
}));

import { clearSubscriptionQueue, debouncedGetEntitiesFromTorii } from "./debounced-queries";
import { getEntitiesFromTorii } from "./queries";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("debounced query queue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSubscriptionQueue();
  });

  it("resolves only after queued request has completed", async () => {
    const request = deferred<void>();
    vi.mocked(getEntitiesFromTorii).mockImplementationOnce(async () => request.promise);

    const onComplete = vi.fn();
    let settled = false;

    const pending = debouncedGetEntitiesFromTorii({} as any, [] as any, [1], ["s1_eternum-Structure"], onComplete).then(
      () => {
        settled = true;
      },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();

    request.resolve(undefined);
    await pending;

    expect(settled).toBe(true);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("calls onComplete exactly once when request fails", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(getEntitiesFromTorii).mockRejectedValueOnce(new Error("boom"));

    const onComplete = vi.fn();

    await debouncedGetEntitiesFromTorii({} as any, [] as any, [1], ["s1_eternum-Structure"], onComplete);

    expect(onComplete).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it("rejects and completes pending queued request when queue is cleared", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const firstRequest = deferred<void>();
    let secondExecuted = false;

    vi.mocked(getEntitiesFromTorii)
      .mockImplementationOnce(async () => firstRequest.promise)
      .mockImplementationOnce(async () => {
        secondExecuted = true;
      });

    void debouncedGetEntitiesFromTorii({} as any, [] as any, [1], ["s1_eternum-Structure"]);
    await Promise.resolve();

    const secondOnComplete = vi.fn();
    const secondPending = debouncedGetEntitiesFromTorii(
      {} as any,
      [] as any,
      [2],
      ["s1_eternum-Structure"],
      secondOnComplete,
    );

    clearSubscriptionQueue();
    await secondPending;

    expect(secondExecuted).toBe(false);
    expect(secondOnComplete).toHaveBeenCalledTimes(1);

    firstRequest.resolve(undefined);
    await Promise.resolve();
    consoleErrorSpy.mockRestore();
  });
});
