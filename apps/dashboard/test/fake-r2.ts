/**
 * In-memory stand-in for the `UPLOADS` R2 bucket (the `UploadStore` slice
 * of `R2Bucket` that app/lib/csv.server.ts uses). Bodies are served as
 * byte streams in small chunks so the streaming CSV parser is exercised
 * across chunk boundaries, as it is against real R2.
 */
import type { StoredObject, UploadStore } from "~/lib/csv.server";

export interface FakeBucket extends UploadStore {
  objects: Map<string, Uint8Array>;
  /** Decoded text of a stored object, for assertions. */
  textOf(key: string): string | null;
}

export function fakeBucket(chunkSize = 1024): FakeBucket {
  const objects = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    objects,
    async put(key, value) {
      objects.set(
        key,
        typeof value === "string"
          ? encoder.encode(value)
          : new Uint8Array(value.slice(0)),
      );
      return null;
    },
    async get(key): Promise<StoredObject | null> {
      const bytes = objects.get(key);
      if (bytes === undefined) return null;
      return {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            for (let i = 0; i < bytes.length; i += chunkSize) {
              controller.enqueue(bytes.slice(i, i + chunkSize));
            }
            controller.close();
          },
        }),
        text: async () => decoder.decode(bytes),
      };
    },
    async delete(key) {
      objects.delete(key);
    },
    textOf(key) {
      const bytes = objects.get(key);
      return bytes === undefined ? null : decoder.decode(bytes);
    },
  };
}

/**
 * Records every `sendBatch`; `messages` is the flat list in send order. The
 * import only ever produces `review.index` messages, so that is what the
 * recorder exposes (the queue's wire type is the wider `IngestMessage`).
 */
export function fakeQueue() {
  const batches: import("@proofql/core").ReviewIndexMessage[][] = [];
  return {
    batches,
    get messages() {
      return batches.flat();
    },
    async sendBatch(
      messages: Iterable<{ body: import("@proofql/core").IngestMessage }>,
    ) {
      batches.push(
        [...messages].map(
          (m) => m.body as import("@proofql/core").ReviewIndexMessage,
        ),
      );
    },
  };
}

/** What workerd throws once the free plan's daily Queues operations are spent (#159). */
export const QUEUE_LIMIT_MESSAGE =
  "Queue sendBatch failed: Free tier limit exceeded";

/** An ingest queue whose every `sendBatch` throws `message`; counts the attempts. */
export function failingQueue(message = QUEUE_LIMIT_MESSAGE) {
  const queue = {
    attempts: 0,
    async sendBatch(
      _messages: Iterable<{ body: import("@proofql/core").IngestMessage }>,
    ): Promise<void> {
      queue.attempts += 1;
      throw new Error(message);
    },
  };
  return queue;
}
