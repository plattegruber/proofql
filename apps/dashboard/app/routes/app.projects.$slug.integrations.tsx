// Integrations tab (#45): the project's Google Business Profile connection.
// Three states — the connector is dark (pending Google's API approval), not
// connected, connected — and for a connected project the location picker,
// the last sync, Reconnect (a plain link into the OAuth flow) and an
// inline-confirmed Disconnect. Saving the picker sets
// `initial_sync_pending` and enqueues a `connection.sync`, so the first
// reviews land within seconds (docs/google.md).
import { data, Form, redirect, useNavigation } from "react-router";

import { InlineConfirm } from "~/components/form/inline-confirm";
import { SubmitButton } from "~/components/form/submit-button";
import { Overline } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/form-controls";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import { setFlash } from "~/lib/flash.server";
import {
  type ConnectionView,
  connectionView,
  connectorEnabled,
  connectPath,
  disconnectGoogle,
  findGoogleConnection,
  integrationsPath,
  latestGoogleRun,
  saveLocationSelection,
} from "~/lib/google.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.projects.$slug.integrations";

/** The epic's user-gated item: Google Business Profile API access. */
const API_ACCESS_ISSUE_URL =
  "https://github.com/plattegruber/proofql/issues/44";
const GOOGLE_VERIFY_HELP_URL =
  "https://support.google.com/business/answer/7107242";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const { env } = getCloudflare(args.context);
  return withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    const connection = await findGoogleConnection(db, project.id);
    const run = connection ? await latestGoogleRun(db, project.id) : undefined;
    return {
      project: { slug: project.slug, name: project.name },
      connectorEnabled: connectorEnabled(env),
      connection: connection ? connectionView(connection, run) : null,
    };
  });
}

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const form = await args.request.formData();
  const intent = form.get("intent");

  const project = await withRequestDb(args.context, (db) =>
    findProjectBySlug(db, account.id, args.params.slug),
  );
  if (!project) throw data(null, { status: 404 });
  const back = integrationsPath(project.slug);

  if (intent === "save-locations") {
    const enabledIds = form
      .getAll("location")
      .filter((v): v is string => typeof v === "string");
    const saved = await withRequestDb(args.context, (db) =>
      saveLocationSelection(db, { projectId: project.id, enabledIds }),
    );
    if (!saved) throw data("No Google connection to save to", { status: 409 });
    if (saved.enabled.length > 0) {
      // After the commit, never inside it: the pipeline re-reads the row.
      await env.INGEST_QUEUE.send(saved.message);
    }
    log.log("google.locations_saved", {
      project_id: project.id,
      connection_id: saved.connection.id,
      enabled: saved.enabled.length,
      location_ids: saved.enabled.map((l) => l.id),
      sync_enqueued: saved.enabled.length > 0,
    });
    return redirect(back, {
      headers: await setFlash(env, {
        tone: "positive",
        message: "Locations saved",
        detail:
          saved.enabled.length === 0
            ? "No location is enabled, so nothing will be polled."
            : `Syncing ${saved.enabled.length} location${saved.enabled.length === 1 ? "" : "s"} now; reviews appear within a minute, then every six hours.`,
      }),
    });
  }

  if (intent === "disconnect") {
    const row = await withRequestDb(args.context, (db) =>
      disconnectGoogle(db, project.id),
    );
    if (!row) throw data("No Google connection", { status: 409 });
    log.log("google.disconnected", {
      project_id: project.id,
      connection_id: row.id,
    });
    return redirect(back, {
      headers: await setFlash(env, {
        tone: "neutral",
        message: "Google disconnected",
        detail: "The credentials were deleted. Reviews already imported stay.",
      }),
    });
  }

  throw data("Unknown intent", { status: 400 });
}

// --- Component ---------------------------------------------------------------

export default function ProjectIntegrations({
  loaderData,
}: Route.ComponentProps) {
  const { project, connection } = loaderData;
  if (!loaderData.connectorEnabled) return <PendingApproval />;
  if (!connection || connection.status === "disconnected") {
    return (
      <NotConnected slug={project.slug} wasConnected={connection !== null} />
    );
  }
  return <Connected slug={project.slug} connection={connection} />;
}

function GoogleHeading({ status }: { status?: ConnectionView["status"] }) {
  return (
    <div className="flex items-center gap-3">
      <GoogleMark />
      <h3 className="m-0 text-title font-semibold text-ink-900">
        Google Business Profile
      </h3>
      {status === "active" && <Badge tone="positive">Connected</Badge>}
      {status === "needs_reauth" && (
        <Badge tone="caution">Needs reconnect</Badge>
      )}
    </div>
  );
}

function PendingApproval() {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <GoogleHeading />
        <Badge tone="neutral">Pending approval</Badge>
      </div>
      <p className="mt-3 mb-0 max-w-2xl text-small text-gray-600">
        Google connection is pending approval. Google reviews the application
        that will read your reviews before it is allowed to; until then this
        connector is switched off everywhere. Follow{" "}
        <a href={API_ACCESS_ISSUE_URL} className="text-link">
          the approval
        </a>
        , or import a CSV export from Google in the meantime.
      </p>
    </Card>
  );
}

function NotConnected({
  slug,
  wasConnected,
}: {
  slug: string;
  wasConnected: boolean;
}) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <GoogleHeading />
          <p className="mt-3 mb-0 max-w-2xl text-small text-gray-600">
            Reviews from your Google Business Profile, kept in sync every six
            hours. You sign in with the Google account that manages the
            business; ProofQL reads reviews and never posts or replies.
            {wasConnected &&
              " This project was connected before; connecting again picks up where it left off."}
          </p>
        </div>
        <a
          href={connectPath(slug)}
          className={cn(
            buttonVariants({ variant: "primary", size: "md" }),
            "no-underline",
          )}
        >
          Connect Google
        </a>
      </div>
    </Card>
  );
}

function Connected({
  slug,
  connection,
}: {
  slug: string;
  connection: ConnectionView;
}) {
  const navigation = useNavigation();
  const disconnecting =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "disconnect";
  const verified = connection.locations.filter((l) => l.verified);
  const enabled = connection.locations.filter((l) => l.enabled);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <GoogleHeading status={connection.status} />
            {connection.status === "needs_reauth" ? (
              <p className="mt-3 mb-0 max-w-2xl text-small text-gray-600">
                Google no longer accepts this project's access. That happens
                when access is revoked in the Google account, or every seven
                days while the ProofQL app is in Google's testing mode. Polling
                is paused; reviews already imported stay. Reconnect to resume.
              </p>
            ) : (
              <SyncStatus
                connection={connection}
                enabledCount={enabled.length}
              />
            )}
          </div>
          <a
            href={connectPath(slug)}
            className={cn(
              buttonVariants({
                variant:
                  connection.status === "needs_reauth"
                    ? "primary"
                    : "secondary",
                size: "sm",
              }),
              "no-underline",
            )}
          >
            Reconnect
          </a>
        </div>
      </Card>

      <Form method="post">
        <input type="hidden" name="intent" value="save-locations" />
        <Card
          title="Locations"
          action={
            <span className="font-mono text-label text-gray-500">
              {enabled.length} of {verified.length} verified enabled
            </span>
          }
        >
          <p className="m-0 mb-4 text-small text-gray-600">
            Reviews are polled for the locations you tick. Each review carries
            its location in{" "}
            <code className="font-mono text-data">metadata.location</code>, so a
            page can filter to one branch.
          </p>
          {connection.locations.length === 0 ? (
            <p className="m-0 text-small text-gray-600">
              No locations were found on the connected Google account. Reconnect
              with the account that manages the Business Profile.
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {connection.locations.map((location) => {
                const id = `location-${location.id}`;
                return (
                  <li
                    key={location.id}
                    className="flex items-start gap-3 border border-hairline bg-surface-card px-3.5 py-3"
                  >
                    <Checkbox
                      id={id}
                      name="location"
                      value={location.id}
                      defaultChecked={location.enabled}
                      disabled={!location.verified}
                      aria-describedby={`${id}-detail`}
                      className="mt-0.5"
                    />
                    <label
                      htmlFor={id}
                      className="flex min-w-0 flex-1 flex-col gap-0.5"
                    >
                      <span className="flex flex-wrap items-center gap-2 text-small font-medium text-ink-900">
                        {location.title}
                        {!location.verified && (
                          <Badge tone="caution">Unverified</Badge>
                        )}
                      </span>
                      <span
                        id={`${id}-detail`}
                        className="text-small text-gray-600"
                      >
                        {location.verified
                          ? location.address || `Location ${location.id}`
                          : "Google only serves reviews for verified locations."}
                        {!location.verified && (
                          <>
                            {" "}
                            <a
                              href={GOOGLE_VERIFY_HELP_URL}
                              className="text-link"
                            >
                              Verify it on Google
                            </a>
                            , then reconnect.
                          </>
                        )}
                      </span>
                    </label>
                    {connection.accounts[location.account] &&
                      Object.keys(connection.accounts).length > 1 && (
                        <span className="font-mono text-label text-gray-500">
                          {connection.accounts[location.account]}
                        </span>
                      )}
                  </li>
                );
              })}
            </ul>
          )}
          {connection.locations.length > 0 && (
            <div className="mt-4">
              <SubmitButton pendingLabel="Saving…" disabled={disconnecting}>
                Save locations
              </SubmitButton>
            </div>
          )}
        </Card>
      </Form>

      <Card title="Disconnect" className="border-red-700">
        <p className="m-0 mb-4 text-small text-gray-600">
          Deletes the stored Google credentials and stops polling. Reviews
          already imported stay in this project; you can connect again later.
        </p>
        <Form method="post">
          <InlineConfirm
            trigger="Disconnect Google"
            triggerVariant="danger"
            message="This deletes the Google credentials for this project and stops syncing. Imported reviews are kept."
            confirmLabel="Disconnect"
            pendingLabel="Disconnecting…"
            className="max-w-xl"
          >
            <input type="hidden" name="intent" value="disconnect" />
          </InlineConfirm>
        </Form>
      </Card>
    </div>
  );
}

function SyncStatus({
  connection,
  enabledCount,
}: {
  connection: ConnectionView;
  enabledCount: number;
}) {
  const run = connection.lastRun;
  return (
    <dl className="mt-3 mb-0 grid gap-x-8 gap-y-2 text-small md:grid-cols-3">
      <div>
        <dt>
          <Overline>Last synced</Overline>
        </dt>
        <dd className="m-0 mt-1 text-ink-900">
          {connection.lastSyncedAt ? (
            <time dateTime={connection.lastSyncedAt}>
              {formatWhen(connection.lastSyncedAt)}
            </time>
          ) : connection.initialSyncPending ? (
            "Syncing now…"
          ) : enabledCount === 0 ? (
            "Not yet — choose locations below"
          ) : (
            "Waiting for the first sync"
          )}
        </dd>
      </div>
      <div>
        <dt>
          <Overline>Last run</Overline>
        </dt>
        <dd className="m-0 mt-1 text-ink-900">
          {run ? (
            run.status === "failed" ? (
              <span className="text-danger">{run.error ?? "Failed"}</span>
            ) : (
              `${run.created} new, ${run.updated} updated${run.failed > 0 ? `, ${run.failed} over the plan limit` : ""}`
            )
          ) : (
            "—"
          )}
        </dd>
      </div>
      <div>
        <dt>
          <Overline>Cadence</Overline>
        </dt>
        <dd className="m-0 mt-1 text-ink-900">Every 6 hours</dd>
      </div>
    </dl>
  );
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });
}

/** Google's four-colour "G", 16px. */
function GoogleMark() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 48 48"
      role="img"
      focusable="false"
    >
      <title>Google</title>
      <path
        fill="#EA4335"
        d="M24 9.5c3.5 0 6.6 1.2 9.1 3.5l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.3l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.6 3-2.3 5.5-4.8 7.2l7.6 5.9c4.5-4.1 7-10.2 7-17.6z"
      />
      <path
        fill="#FBBC05"
        d="M10.5 28.6A14.5 14.5 0 0 1 9.5 24c0-1.6.3-3.2.8-4.6l-7.9-6.1A24 24 0 0 0 0 24c0 3.9.9 7.5 2.6 10.7l7.9-6.1z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.1-13.5-9.9l-7.9 6.1C6.5 42.6 14.6 48 24 48z"
      />
    </svg>
  );
}
