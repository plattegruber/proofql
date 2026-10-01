import { describe, expect, it, vi } from "vitest";

import { handleFetch, handleQueueBatch } from "./handlers.js";

describe("pipeline handlers", () => {
  it("acks every message in a batch", () => {
    const ackAll = vi.fn();

    handleQueueBatch({ queue: "proofql-ingest", ackAll });

    expect(ackAll).toHaveBeenCalledOnce();
  });

  it("GET /health returns { ok: true }", async () => {
    const res = handleFetch(new Request("http://pipeline.local/health"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("other paths 404", () => {
    const res = handleFetch(new Request("http://pipeline.local/nope"));

    expect(res.status).toBe(404);
  });
});
