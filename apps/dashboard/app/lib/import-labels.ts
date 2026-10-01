// Client-safe pieces of the import wizard: labels for the selects and the
// byte formatter the upload form shows. Kept out of csv.server.ts so route
// components can import them without dragging server code into the
// client bundle.
import { CSV_PROFILES, type ReviewSource } from "@proofql/core";

export const PROFILE_OPTIONS = CSV_PROFILES.map((p) => ({
  value: p.id,
  label: p.label,
}));

export const SOURCE_LABELS: Record<ReviewSource, string> = {
  google: "Google",
  yelp: "Yelp",
  facebook: "Facebook",
  trustpilot: "Trustpilot",
  custom: "Custom",
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
