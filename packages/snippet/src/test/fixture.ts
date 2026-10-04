import type { QueryResponse } from "../types.js";

/** A realistic `GET /v1/query` response; excerpt 1 carries hostile markup. */
export function fixtureResponse(
  overrides: Partial<QueryResponse> = {},
): QueryResponse {
  return {
    results: [
      {
        score: 0.83,
        excerpt:
          "Dr. Patel explained the implant process clearly <script>alert(1)</script> & I felt at ease.",
        excerpt_id: "c1",
        highlight: { start: 25, end: 116 },
        review: {
          id: "r1",
          rating: 5,
          author_name: "Maria <b>G.</b>",
          author_avatar_url: null,
          source: "google",
          occurred_at: "2026-01-15T10:30:00.000Z",
          url: "https://maps.google.com/?cid=123",
          metadata: { location: "north" },
          text: "Full review text for r1. Dr. Patel explained the implant process clearly <script>alert(1)</script> & I felt at ease. Would recommend.",
        },
      },
      {
        score: 0.71,
        excerpt: "Quick, painless, and the front desk was lovely.",
        excerpt_id: "c2",
        highlight: null,
        review: {
          id: "r2",
          rating: 4,
          author_name: null,
          author_avatar_url: null,
          source: "custom",
          occurred_at: null,
          url: "javascript:alert(1)",
          metadata: {},
        },
      },
      {
        score: null,
        excerpt: "Great with nervous kids.",
        excerpt_id: "c3",
        highlight: null,
        review: {
          id: "r3",
          rating: null,
          author_name: "J. Okafor",
          author_avatar_url: null,
          source: "yelp",
          occurred_at: "2025-11-02T00:00:00.000Z",
          url: null,
          metadata: {},
        },
      },
    ],
    took_ms: 12,
    cached: false,
    badge: true,
    ...overrides,
  };
}

/** A `fetch` stub answering every call with `body` (or a thrown error). */
export function stubFetch(
  answer:
    | { status?: number; body?: unknown; text?: string }
    | { throws: unknown },
): ReturnType<typeof import("vitest").vi.fn> & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    calls.push(String(input));
    if ("throws" in answer) throw answer.throws;
    const text = answer.text ?? JSON.stringify(answer.body ?? {});
    return new Response(text, {
      status: answer.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as ReturnType<typeof import("vitest").vi.fn> & {
    calls: string[];
  };
  fn.calls = calls;
  return fn;
}
