/**
 * The public API, called the way a customer's server would: secret key in
 * `Authorization`, JSON in and out. Shapes are docs/api/openapi.yaml.
 * Keys never reach a log line or an error message.
 */
import { target } from "./target";

const USER_AGENT = "proofql-acceptance-tests";

export interface IngestReview {
  external_id: string;
  source: "custom";
  rating: number;
  text: string;
  author_name: string;
  occurred_at: string;
  metadata: Record<string, string>;
}

export interface StoredReview {
  id: string;
  external_id: string;
  status: string;
}

export interface QueryResult {
  score: number | null;
  matched: boolean;
  excerpt: string;
  highlight: { start: number; end: number } | null;
  review: { id: string; text?: string; rating: number | null };
}

export interface QueryResponse {
  match: "query" | "none" | "fallback" | "recent";
  results: QueryResult[];
}

async function call<T>(
  method: string,
  path: string,
  secretKey: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${target.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "User-Agent": USER_AGENT,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? null : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  return JSON.parse(text) as T;
}

export async function ingest(
  secretKey: string,
  reviews: IngestReview[],
): Promise<StoredReview[]> {
  const res = await call<{ reviews: StoredReview[] }>(
    "POST",
    "/v1/reviews",
    secretKey,
    reviews,
  );
  return res.reviews;
}

export async function listReviews(secretKey: string): Promise<StoredReview[]> {
  const res = await call<{ reviews: StoredReview[] }>(
    "GET",
    "/v1/reviews?source=custom&limit=100",
    secretKey,
  );
  return res.reviews;
}

export async function query(
  secretKey: string,
  q: string,
): Promise<QueryResponse> {
  return call<QueryResponse>("POST", "/v1/query", secretKey, {
    q,
    limit: 3,
    include: ["text"],
  });
}
