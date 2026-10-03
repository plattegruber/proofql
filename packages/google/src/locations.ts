/**
 * The connection's location mapping — `connections.metadata.locations` —
 * and the ids the two Google surfaces disagree on.
 *
 * Business Information v1 names a location `locations/{l}`; the v4 reviews
 * endpoint wants `accounts/{a}/locations/{l}`. We store both halves bare
 * and rebuild the v4 parent when polling. `verified` comes from discovery
 * (`metadata.hasVoiceOfMerchant`); `enabled` is the user's choice in the
 * dashboard's location picker (#45). The poller reads only locations that
 * are both.
 *
 * `connections.cursor` is a JSON map `{ [locationId]: <newest updateTime
 * seen> }`, and `metadata.initial_sync_pending` asks the next tick (or the
 * `connection.sync` queue message) to process the connection at once.
 */

import { z } from "zod";

// A strict object (unknown keys stripped), not a loose one: this shape is
// ours, it travels through React Router loader data, and an index
// signature would leak into every view type that carries a location.
export const mappedLocationSchema = z.object({
  /** The bare id from `locations/{id}`. */
  id: z.string().min(1),
  /** The bare id from `accounts/{id}` the location was listed under. */
  account: z.string().min(1),
  title: z.string(),
  address: z.string().optional(),
  verified: z.boolean(),
  enabled: z.boolean(),
  /** Google Maps place id when discovery saw one; derives the review URL. */
  placeId: z.string().optional(),
});
export type MappedLocation = z.infer<typeof mappedLocationSchema>;

export const connectionMetadataSchema = z.looseObject({
  locations: z.array(mappedLocationSchema).default([]),
  initial_sync_pending: z.boolean().optional(),
  /** Google account display names by bare account id, for the picker. */
  accounts: z.record(z.string(), z.string()).optional(),
  /** When discovery last ran (ISO). */
  discovered_at: z.string().optional(),
});
export type ConnectionMetadata = z.infer<typeof connectionMetadataSchema>;

/** Parse `connections.metadata`; anything unreadable counts as empty. */
export function parseConnectionMetadata(raw: unknown): ConnectionMetadata {
  const parsed = connectionMetadataSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : { locations: [] };
}

export type LocationCursor = Record<string, string>;

/** Parse `connections.cursor` (a JSON map); null or garbage is an empty map. */
export function parseLocationCursor(
  raw: string | null | undefined,
): LocationCursor {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    const out: LocationCursor = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function serializeLocationCursor(cursor: LocationCursor): string {
  return JSON.stringify(cursor);
}

/** `accounts/{a}/locations/{l}` — the v4 reviews parent. */
export function v4LocationName(location: {
  account: string;
  id: string;
}): string {
  return `accounts/${location.account}/locations/${location.id}`;
}

/** The bare id after the last `/` (`locations/123` → `123`). */
export function bareId(resourceName: string): string {
  const slash = resourceName.lastIndexOf("/");
  return slash === -1 ? resourceName : resourceName.slice(slash + 1);
}

/** Locations the poller reads: mapped, enabled, and verified. */
export function pollableLocations(
  metadata: ConnectionMetadata,
): MappedLocation[] {
  return metadata.locations.filter((l) => l.enabled && l.verified);
}
