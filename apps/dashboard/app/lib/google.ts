// The Google connector's browser-safe pieces: route paths and the view model
// the Integrations tab renders. Kept out of google.server.ts because the
// tab's component uses them, and React Router strips `.server` modules from
// the client bundle (anything a component touches must live here).
import type { MappedLocation } from "@proofql/google";

export const CALLBACK_PATH = "/app/integrations/google/callback";

export function integrationsPath(slug: string): string {
  return `/app/projects/${slug}/integrations`;
}

export function connectPath(slug: string): string {
  return `${integrationsPath(slug)}/google/connect`;
}

export type ConnectionStatus = "active" | "needs_reauth" | "disconnected";
export type RunStatus = "running" | "succeeded" | "failed";

/** What the tab renders; dates as ISO strings so loader data is stable across the wire. */
export interface ConnectionView {
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  initialSyncPending: boolean;
  discoveredAt: string | null;
  accounts: Record<string, string>;
  locations: MappedLocation[];
  lastRun: {
    status: RunStatus;
    startedAt: string;
    finishedAt: string | null;
    created: number;
    updated: number;
    skipped: number;
    failed: number;
    error: string | null;
  } | null;
}
