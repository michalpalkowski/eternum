import { HexPosition, ID } from "@bibliothecadao/types";
import { Component, Metadata, Schema } from "@dojoengine/recs";
import { ToriiClient } from "@dojoengine/torii-client";
import {
  getBuildingsFromTorii,
  getEntitiesFromTorii,
  getOwnedArmiesFromTorii,
  getTilesForPositionsFromTorii,
} from "./queries";
import { setQueueDepth, perfEvent } from "./perf-diagnostics";

type QueueItem = {
  run: () => Promise<void>;
  reject: (reason?: unknown) => void;
};

// Queue class to manage requests
class RequestQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private batchSize = 3; // Number of concurrent requests
  private batchDelayMs = 100; // Delay between batches

  add(request: () => Promise<void>, onComplete?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        reject,
        run: async () => {
          try {
            await request();
            onComplete?.(); // Call onComplete after the request is processed
            resolve();
          } catch (error) {
            reject(error);
          }
        },
      });

      setQueueDepth("subscriptionQueue", this.queue.length);
      if (this.queue.length > 10) {
        perfEvent("subscriptionQueue:highDepth", { depth: this.queue.length });
      }

      if (!this.processing) {
        this.processing = true;
        void this.processQueue();
      }
    });
  }

  private async processQueue() {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.batchSize);
      setQueueDepth("subscriptionQueue", this.queue.length);

      const t0 = performance.now();
      try {
        await Promise.all(batch.map((item) => item.run()));
      } catch (error) {
        console.error("Error processing request batch:", error);
      }
      const batchMs = performance.now() - t0;
      if (batchMs > 500) {
        perfEvent("subscriptionQueue:slowBatch", { batchSize: batch.length, durationMs: Math.round(batchMs), remaining: this.queue.length });
      }

      if (this.queue.length > 0) {
        // Add delay between batches to prevent overwhelming the server
        await new Promise((resolve) => setTimeout(resolve, this.batchDelayMs));
      }
    }
    this.processing = false;
    setQueueDepth("subscriptionQueue", 0);
  }

  clear() {
    const pending = this.queue.splice(0, this.queue.length);
    pending.forEach((item) => item.reject(new Error("Request queue cleared before execution")));
  }
}

const subscriptionQueue = new RequestQueue();

/**
 * Clear all pending queued requests.
 * Called during game/world switching to prevent in-flight requests
 * from the old world writing stale data into RECS.
 */
export const clearSubscriptionQueue = () => {
  subscriptionQueue.clear();
};

export const debouncedGetOwnedArmiesFromTorii = async <S extends Schema>(
  client: ToriiClient,
  components: Component<S, Metadata, undefined>[],
  owners: number[],
  onComplete?: () => void,
) => {
  try {
    await subscriptionQueue.add(() => getOwnedArmiesFromTorii(client, components, owners), onComplete);
  } catch (error) {
    console.error("Error in debouncedGetOwnedEntitiesFromTorii:", error);
    // Make sure onComplete is called even if there's an error
    onComplete?.();
  }
};

export const debouncedGetEntitiesFromTorii = async <S extends Schema>(
  client: ToriiClient,
  components: Component<S, Metadata, undefined>[],
  entityIDs: ID[],
  entityModels: string[],
  onComplete?: () => void,
) => {
  try {
    await subscriptionQueue.add(() => getEntitiesFromTorii(client, components, entityIDs, entityModels), onComplete);
  } catch (error) {
    console.error("Error in debouncedGetEntitiesFromTorii:", error);
    // Make sure onComplete is called even if there's an error
    onComplete?.();
  }
};

export const debouncedGetBuildingsFromTorii = async <S extends Schema>(
  client: ToriiClient,
  components: Component<S, Metadata, undefined>[],
  structurePositions: HexPosition[],
  onComplete?: () => void,
) => {
  try {
    await subscriptionQueue.add(() => getBuildingsFromTorii(client, components, structurePositions), onComplete);
  } catch (error) {
    console.error("Error in debouncedGetBuildingsFromTorii:", error);
    // Make sure onComplete is called even if there's an error
    onComplete?.();
  }
};

const debouncedGetTilesForPositionsFromTorii = async <S extends Schema>(
  client: ToriiClient,
  components: Component<S, Metadata, undefined>[],
  positions: HexPosition[],
  onComplete?: () => void,
) => {
  try {
    await subscriptionQueue.add(async () => {
      await getTilesForPositionsFromTorii(client, components, positions);
      return;
    }, onComplete);
  } catch (error) {
    console.error("Error in debouncedGetTilesForPositionsFromTorii:", error);
    // Make sure onComplete is called even if there's an error
    onComplete?.();
  }
};
