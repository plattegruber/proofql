/**
 * A fake Places API (New) — the two endpoints the bootstrap (#47) uses:
 *
 *   POST /v1/places:searchText   { textQuery, pageSize } → { places: [...] }
 *   GET  /v1/places/{id}                                  → the place
 *
 * One `fetch`-shaped function, so the client takes it in-process in tests
 * (no sockets), and `fake-places-server.ts` serves the same handler on a
 * port for a manual run (`PLACES_API_BASE=http://localhost:8803`).
 *
 * Behaviour copied from the real API where it matters: an `X-Goog-Api-Key`
 * header is required (403 PERMISSION_DENIED without one, 400 INVALID_ARGUMENT
 * for the key `bad`), `X-Goog-FieldMask` decides whether `reviews` is in the
 * body, a search with no match answers `{}` (not an empty array), and an
 * unknown place is 404 NOT_FOUND. Responses are the documented shapes; the
 * fixtures are fiction.
 *
 * Self-contained on purpose (no `~/` imports): Node runs it as a script.
 */

export interface FakePlace {
  id: string;
  displayName: { text: string; languageCode: string };
  formattedAddress: string;
  rating?: number;
  userRatingCount: number;
  reviews?: FakeReview[];
}

export interface FakeReview {
  name: string;
  rating: number;
  text?: { text: string; languageCode: string };
  originalText?: { text: string; languageCode: string };
  authorAttribution?: { displayName?: string; uri?: string; photoUri?: string };
  publishTime: string;
  relativePublishTimeDescription?: string;
  googleMapsUri?: string;
}

export const CEDAR_RIDGE_ID = "ChIJcedarridge0000001";
export const HARBOR_LIGHT_ID = "ChIJharborlight000002";
export const QUIET_CORNER_ID = "ChIJquietcorner000003";

/** Five reviews; one is `originalText` only (Google had no translation). */
const cedarRidge: FakePlace = {
  id: CEDAR_RIDGE_ID,
  displayName: { text: "Cedar Ridge Dental", languageCode: "en" },
  formattedAddress: "1200 Cedar Ridge Rd, Boulder, CO 80302, USA",
  rating: 4.8,
  userRatingCount: 212,
  reviews: [
    {
      name: `places/${CEDAR_RIDGE_ID}/reviews/r-implant-1`,
      rating: 5,
      text: {
        text: "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week. Parking behind the building was easy.",
        languageCode: "en",
      },
      originalText: {
        text: "Dr. Patel did my implant and I honestly forgot it wasn't my own tooth within a week. Parking behind the building was easy.",
        languageCode: "en",
      },
      authorAttribution: {
        displayName: "Marcus T.",
        uri: "https://www.google.com/maps/contrib/100000000000000000001/reviews",
        photoUri: "https://lh3.googleusercontent.com/a/fake-marcus=s128",
      },
      publishTime: "2026-03-14T18:20:00Z",
      relativePublishTimeDescription: "6 months ago",
      googleMapsUri:
        "https://www.google.com/maps/reviews/data=fake-r-implant-1",
    },
    {
      name: `places/${CEDAR_RIDGE_ID}/reviews/r-kids-2`,
      rating: 5,
      text: {
        text: "Gentle with my four-year-old, who left asking when we could come back. Saturday hours made it work for us.",
        languageCode: "en",
      },
      authorAttribution: {
        displayName: "Priya S.",
        uri: "https://www.google.com/maps/contrib/100000000000000000002/reviews",
      },
      publishTime: "2026-05-02T15:45:00Z",
      relativePublishTimeDescription: "5 months ago",
    },
    {
      // Spanish review Google did not translate: `originalText` only.
      name: `places/${CEDAR_RIDGE_ID}/reviews/r-limpieza-3`,
      rating: 4,
      originalText: {
        text: "La limpieza fue rápida y la higienista muy amable. Buen estacionamiento detrás del edificio.",
        languageCode: "es",
      },
      authorAttribution: {
        displayName: "Lucía R.",
        uri: "https://www.google.com/maps/contrib/100000000000000000003/reviews",
      },
      publishTime: "2026-01-20T09:10:00Z",
      relativePublishTimeDescription: "8 months ago",
    },
    {
      name: `places/${CEDAR_RIDGE_ID}/reviews/r-whitening-4`,
      rating: 5,
      text: {
        text: "Whitening took one visit and the front desk explained every charge before I paid. No surprises on the invoice.",
        languageCode: "en",
      },
      authorAttribution: {
        displayName: "Dana K.",
        uri: "https://www.google.com/maps/contrib/100000000000000000004/reviews",
        photoUri: "https://lh3.googleusercontent.com/a/fake-dana=s128",
      },
      publishTime: "2025-11-08T20:00:00Z",
      relativePublishTimeDescription: "a year ago",
      googleMapsUri:
        "https://www.google.com/maps/reviews/data=fake-r-whitening-4",
    },
    {
      // No attribution name at all.
      name: `places/${CEDAR_RIDGE_ID}/reviews/r-crown-5`,
      rating: 4,
      text: {
        text: "Crown fitted on the second visit and it matches the others. Booking online was easy.",
        languageCode: "en",
      },
      authorAttribution: {},
      publishTime: "2025-09-30T12:00:00Z",
      relativePublishTimeDescription: "a year ago",
    },
  ],
};

/** Two reviews; one is rating-only (no text, no originalText). */
const harborLight: FakePlace = {
  id: HARBOR_LIGHT_ID,
  displayName: { text: "Harbor Light Bakery", languageCode: "en" },
  formattedAddress: "48 Pearl St, Boulder, CO 80302, USA",
  rating: 4.5,
  userRatingCount: 2,
  reviews: [
    {
      name: `places/${HARBOR_LIGHT_ID}/reviews/r-sourdough-1`,
      rating: 5,
      text: {
        text: "The sourdough sells out by ten; get there early. Worth it.",
        languageCode: "en",
      },
      authorAttribution: {
        displayName: "Jo M.",
        uri: "https://www.google.com/maps/contrib/100000000000000000011/reviews",
      },
      publishTime: "2026-06-01T14:00:00Z",
    },
    {
      name: `places/${HARBOR_LIGHT_ID}/reviews/r-stars-only-2`,
      rating: 4,
      authorAttribution: {
        displayName: "Sam P.",
        uri: "https://www.google.com/maps/contrib/100000000000000000012/reviews",
      },
      publishTime: "2026-04-12T08:30:00Z",
    },
  ],
};

/** No reviews yet: Google omits the `reviews` field entirely. */
const quietCorner: FakePlace = {
  id: QUIET_CORNER_ID,
  displayName: { text: "Quiet Corner Books", languageCode: "en" },
  formattedAddress: "9 Walnut St, Boulder, CO 80302, USA",
  userRatingCount: 0,
};

export const FAKE_PLACES: readonly FakePlace[] = [
  cedarRidge,
  harborLight,
  quietCorner,
];

function googleError(code: number, status: string, message: string): Response {
  return Response.json({ error: { code, message, status } }, { status: code });
}

function summaryOf(place: FakePlace) {
  const { reviews: _reviews, ...summary } = place;
  return summary;
}

/** Mutable so a test can count calls or make the fake fail. */
export interface FakePlacesApi {
  fetch: typeof fetch;
  calls: { method: string; path: string; fieldMask: string | null }[];
  /** When set, every request answers this instead. */
  failWith?: Response;
}

export function fakePlacesApi(places: readonly FakePlace[] = FAKE_PLACES) {
  const api: FakePlacesApi = {
    calls: [],
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      api.calls.push({
        method: request.method,
        path: url.pathname,
        fieldMask: request.headers.get("x-goog-fieldmask"),
      });
      if (api.failWith) return api.failWith.clone();
      return handle(request, url, places);
    },
  };
  return api;
}

async function handle(
  request: Request,
  url: URL,
  places: readonly FakePlace[],
): Promise<Response> {
  const key = request.headers.get("x-goog-api-key");
  if (!key) {
    return googleError(
      403,
      "PERMISSION_DENIED",
      "The request is missing a valid API key.",
    );
  }
  if (key === "bad") {
    return googleError(
      400,
      "INVALID_ARGUMENT",
      "API key not valid. Please pass a valid API key.",
    );
  }
  const mask = (request.headers.get("x-goog-fieldmask") ?? "").split(",");

  if (request.method === "POST" && url.pathname === "/v1/places:searchText") {
    let body: { textQuery?: unknown; pageSize?: unknown };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return googleError(400, "INVALID_ARGUMENT", "Invalid JSON payload.");
    }
    if (typeof body.textQuery !== "string" || body.textQuery.trim() === "") {
      return googleError(400, "INVALID_ARGUMENT", "text_query must be set.");
    }
    // Every word of the query must appear in the name or the address, so
    // "dental boulder" finds Cedar Ridge Dental as Google would.
    const words = body.textQuery.trim().toLowerCase().split(/\s+/);
    const size =
      typeof body.pageSize === "number" ? Math.min(20, body.pageSize) : 20;
    const matches = places
      .filter((p) => {
        const haystack =
          `${p.displayName.text} ${p.formattedAddress}`.toLowerCase();
        return words.every((w) => haystack.includes(w));
      })
      .slice(0, size)
      .map(summaryOf);
    return Response.json(matches.length === 0 ? {} : { places: matches });
  }

  const placeMatch = /^\/v1\/places\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && placeMatch) {
    const place = places.find((p) => p.id === placeMatch[1]);
    if (!place) {
      return googleError(404, "NOT_FOUND", "Place not found.");
    }
    const body: Record<string, unknown> = summaryOf(place);
    if (mask.includes("*") || mask.includes("reviews")) {
      if (place.reviews) body.reviews = place.reviews;
    }
    return Response.json(body);
  }

  return googleError(
    404,
    "NOT_FOUND",
    `No route for ${request.method} ${url.pathname}.`,
  );
}
