// The pure side of onboarding (#53): the suggested query from chunk texts,
// the prefilled snippet tag, the demo link, the ingest curl, and the step
// paths. No services.
import { describe, expect, it } from "vitest";

import {
  contentWords,
  demoUrl,
  INGEST_SAMPLE,
  indexingSettled,
  ingestCurl,
  onboardingPath,
  onboardingResourcePath,
  onboardingSnippet,
  onboardingStepNumber,
  QUERY_STOP_WORDS,
  suggestQueryFromTexts,
} from "./onboarding";

const DENTAL = [
  "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week. Parking behind the building was easy.",
  "The implant consult was thorough and Dr. Patel explained every option. Easy parking too.",
  "Great hygienist, very gentle cleaning. The parking lot is right behind the building.",
  "Had an implant placed last spring; healed fast. Dr. Patel is the best.",
  "My kids love coming here. Saturday hours and free parking make it easy for us.",
];

describe("contentWords", () => {
  it("drops function words, honorifics, review filler, numbers and short tokens", () => {
    expect(
      contentWords(
        "Dr. Patel's team was great and I'd recommend it to anyone in 2026, 10/10!",
      ),
    ).toEqual(["patel", "anyone"]);
  });

  it("keeps the stop list to lowercase words", () => {
    for (const word of QUERY_STOP_WORDS) {
      expect(word).toBe(word.toLowerCase());
    }
    expect(QUERY_STOP_WORDS.has("implant")).toBe(false);
    expect(QUERY_STOP_WORDS.has("parking")).toBe(false);
  });
});

describe("suggestQueryFromTexts", () => {
  it("pairs the most common content word with the word it most often appears with", () => {
    // "parking" is in 4 of 5 texts; among those, "implant"/"patel" tie at 2
    // and "easy" is in 3 → "parking easy" in the order they usually appear.
    expect(suggestQueryFromTexts(DENTAL)).toBe("parking easy");
  });

  it("falls back to the second most frequent word when nothing co-occurs twice", () => {
    expect(
      suggestQueryFromTexts([
        "implant surgery",
        "implant crown",
        "parking lot",
        "parking garage",
        "whitening",
      ]),
    ).toBe("implant parking");
  });

  it("returns one word for a one-word corpus and null for none", () => {
    expect(suggestQueryFromTexts(["Implants!", "implants"])).toBe("implants");
    expect(suggestQueryFromTexts(["the and of", ""])).toBeNull();
    expect(suggestQueryFromTexts([])).toBeNull();
  });

  it("is deterministic on ties", () => {
    const a = suggestQueryFromTexts(["zebra apple", "apple zebra"]);
    const b = suggestQueryFromTexts(["apple zebra", "zebra apple"]);
    expect(a).toBe("apple zebra");
    expect(b).toBe("apple zebra");
  });
});

describe("onboardingSnippet", () => {
  it("emits the documented tag with the real key and the suggested query", () => {
    expect(
      onboardingSnippet({
        query: "implant parking",
        key: "pq_pk_live_abc",
        snippetSrc: "https://cdn.proofql.com/v1.js",
      }),
    ).toBe(
      '<div data-proofql data-query="implant parking" data-limit="3"></div>\n' +
        '<script async src="https://cdn.proofql.com/v1.js" data-key="pq_pk_live_abc"></script>',
    );
  });

  it("adds data-api only off the default api and escapes attribute values", () => {
    const tag = onboardingSnippet({
      query: 'kids & "gentle" <care>',
      key: "pq_pk_live_abc",
      snippetSrc: "http://localhost:8800/v1.js",
      apiUrl: "http://localhost:8797/",
    });
    expect(tag).toContain(
      'data-query="kids &amp; &quot;gentle&quot; &lt;care>"',
    );
    expect(tag).toContain('data-api="http://localhost:8797"');
    expect(
      onboardingSnippet({
        query: null,
        key: "k",
        snippetSrc: "https://cdn.proofql.com/v1.js",
        apiUrl: "https://api.proofql.com",
      }),
    ).toBe(
      '<div data-proofql data-limit="3"></div>\n<script async src="https://cdn.proofql.com/v1.js" data-key="k"></script>',
    );
  });
});

describe("demoUrl", () => {
  it("points at the cdn's /demo/ with the key, and the api only off the default", () => {
    expect(
      demoUrl(
        "http://localhost:8800/v1.js",
        "pq_pk_live_x",
        "http://localhost:8797",
      ),
    ).toBe(
      "http://localhost:8800/demo/?key=pq_pk_live_x&api=http%3A%2F%2Flocalhost%3A8797",
    );
    expect(demoUrl("https://cdn.proofql.com/v1.js", "pq_pk_live_x")).toBe(
      "https://cdn.proofql.com/demo/?key=pq_pk_live_x",
    );
    expect(demoUrl("https://cdn.proofql.com/v1.js", null)).toBe(
      "https://cdn.proofql.com/demo/",
    );
  });
});

describe("ingestCurl", () => {
  it("posts the three samples to /v1/reviews with the secret key", () => {
    const curl = ingestCurl({
      apiUrl: "http://localhost:8797/",
      secretKey: "pq_sk_live_abc",
    });
    expect(
      curl.startsWith("curl -s -X POST 'http://localhost:8797/v1/reviews'"),
    ).toBe(true);
    expect(curl).toContain("Authorization: Bearer pq_sk_live_abc");
    expect(INGEST_SAMPLE).toHaveLength(3);
    for (const sample of INGEST_SAMPLE) {
      expect(curl).toContain(String(sample.external_id));
      expect(sample).toMatchObject({ source: "custom" });
    }
    // The body round-trips as JSON once the shell quoting is undone.
    const body = curl
      .slice(curl.indexOf("-d '") + 4, -1)
      .replaceAll("'\\''", "'");
    expect(JSON.parse(body)).toEqual(INGEST_SAMPLE);
  });
});

describe("paths and progress", () => {
  it("builds step and resource paths", () => {
    expect(onboardingPath("reviews", "cedar")).toBe(
      "/app/onboarding/cedar/reviews",
    );
    expect(onboardingPath("indexing", "cedar", { run: "r1" })).toBe(
      "/app/onboarding/cedar/indexing?run=r1",
    );
    expect(onboardingResourcePath("status", "cedar")).toBe(
      "/app/onboarding/cedar/status",
    );
    expect(onboardingStepNumber("snippet")).toBe(4);
  });

  it("settles only with at least one review and nothing left to index", () => {
    expect(indexingSettled({ reviews: 0, indexed: 0, indexing: 0 })).toBe(
      false,
    );
    expect(indexingSettled({ reviews: 3, indexed: 2, indexing: 1 })).toBe(
      false,
    );
    expect(indexingSettled({ reviews: 3, indexed: 3, indexing: 0 })).toBe(true);
  });
});
