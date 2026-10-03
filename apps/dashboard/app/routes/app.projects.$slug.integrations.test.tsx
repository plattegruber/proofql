// @vitest-environment happy-dom
// Integrations tab through createRoutesStub, in its three states: the
// connector dark (pending Google's approval), not connected (a plain link
// into the OAuth flow), and connected (status, last sync, the location
// picker with unverified locations disabled and explained, Reconnect on
// needs_reauth, and the inline-confirmed Disconnect).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectionView } from "~/lib/google";
import ProjectIntegrations from "./app.projects.$slug.integrations";

type LoaderData = {
  project: { slug: string; name: string };
  connectorEnabled: boolean;
  connection: ConnectionView | null;
};

const connected: ConnectionView = {
  status: "active",
  lastSyncedAt: "2026-10-01T06:00:00.000Z",
  initialSyncPending: false,
  discoveredAt: "2026-09-30T12:00:00.000Z",
  accounts: { "100": "Cedar Ridge Dental Group" },
  locations: [
    {
      id: "201",
      account: "100",
      title: "Cedar Ridge Dental — North",
      address: "1420 Cedar Ridge Pkwy, Boulder, CO 80301",
      verified: true,
      enabled: true,
    },
    {
      id: "202",
      account: "100",
      title: "Cedar Ridge Dental — South",
      address: "88 Table Mesa Dr, Boulder, CO 80305",
      verified: true,
      enabled: false,
    },
    {
      id: "203",
      account: "100",
      title: "Cedar Ridge Dental — Lakeside",
      address: "5 Lakeside Ave, Longmont, CO 80501",
      verified: false,
      enabled: false,
    },
  ],
  lastRun: {
    status: "succeeded",
    startedAt: "2026-10-01T05:59:00.000Z",
    finishedAt: "2026-10-01T06:00:00.000Z",
    created: 69,
    updated: 2,
    skipped: 1,
    failed: 0,
    error: null,
  },
};

function renderTab(data: Partial<LoaderData>, action = vi.fn()) {
  const loaderData: LoaderData = {
    project: { slug: "cedar", name: "Cedar Ridge Dental" },
    connectorEnabled: true,
    connection: null,
    ...data,
  };
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/integrations",
      loader: () => loaderData,
      action,
      Component: () => (
        <ProjectIntegrations
          loaderData={useLoaderData() as LoaderData}
          actionData={undefined}
          params={{ slug: "cedar" }}
          matches={[] as never}
        />
      ),
    },
  ]);
  return render(<Stub initialEntries={["/app/projects/cedar/integrations"]} />);
}

describe("integrations tab", () => {
  afterEach(cleanup);

  it("says the connector is pending approval when it is switched off", async () => {
    renderTab({ connectorEnabled: false, connection: connected });
    expect(await screen.findByText("Pending approval")).toBeTruthy();
    expect(
      screen.getByText(/Google connection is pending approval/),
    ).toBeTruthy();
    expect(screen.queryByText("Connect Google")).toBeNull();
    expect(screen.queryByText("Save locations")).toBeNull();
  });

  it("offers a plain link into the OAuth flow when not connected", async () => {
    renderTab({ connection: null });
    const connect = await screen.findByRole("link", { name: "Connect Google" });
    expect(connect.getAttribute("href")).toBe(
      "/app/projects/cedar/integrations/google/connect",
    );
    expect(screen.getByText(/never posts or replies/)).toBeTruthy();
  });

  it("treats a disconnected row as not connected, with a note", async () => {
    renderTab({ connection: { ...connected, status: "disconnected" } });
    await screen.findByRole("link", { name: "Connect Google" });
    expect(screen.getByText(/connected before/)).toBeTruthy();
  });

  it("shows status, last sync, and the location picker with unverified locations disabled", async () => {
    const { container } = renderTab({ connection: connected });
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.getByText("69 new, 2 updated")).toBeTruthy();
    expect(container.querySelector("time")?.getAttribute("dateTime")).toBe(
      "2026-10-01T06:00:00.000Z",
    );
    expect(screen.getByText("1 of 2 verified enabled")).toBeTruthy();

    const north = screen.getByLabelText(
      /Cedar Ridge Dental — North/,
    ) as HTMLInputElement;
    const south = screen.getByLabelText(
      /Cedar Ridge Dental — South/,
    ) as HTMLInputElement;
    const lake = screen.getByLabelText(
      /Cedar Ridge Dental — Lakeside/,
    ) as HTMLInputElement;
    expect(north.checked).toBe(true);
    expect(south.checked).toBe(false);
    expect(lake.checked).toBe(false);
    expect(lake.disabled).toBe(true);
    expect(north.disabled).toBe(false);
    expect(
      screen.getByText(/Google only serves reviews for verified locations/),
    ).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();

    const reconnect = screen.getByRole("link", { name: "Reconnect" });
    expect(reconnect.getAttribute("href")).toBe(
      "/app/projects/cedar/integrations/google/connect",
    );
    expect(screen.getByRole("button", { name: "Save locations" })).toBeTruthy();
    expect(container.textContent).not.toContain("!");
  });

  it("explains needs_reauth and leads with Reconnect", async () => {
    renderTab({ connection: { ...connected, status: "needs_reauth" } });
    expect(await screen.findByText("Needs reconnect")).toBeTruthy();
    expect(
      screen.getByText(/no longer accepts this project's access/),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reconnect" })).toBeTruthy();
  });

  it("submits the ticked locations under one field name", async () => {
    const action = vi.fn(async ({ request }: { request: Request }) => {
      const form = await request.formData();
      return { intent: form.get("intent"), locations: form.getAll("location") };
    });
    renderTab({ connection: connected }, action as never);
    const south = (await screen.findByLabelText(
      /Cedar Ridge Dental — South/,
    )) as HTMLInputElement;
    fireEvent.click(south);
    const form = screen
      .getByRole("button", { name: "Save locations" })
      .closest("form");
    if (!form) throw new Error("form not found");
    fireEvent.submit(form);
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await expect(action.mock.results[0]?.value).resolves.toEqual({
      intent: "save-locations",
      locations: ["201", "202"],
    });
  });

  it("disconnects through the inline confirmation, not window.confirm", async () => {
    renderTab({ connection: connected });
    fireEvent.click(
      await screen.findByRole("button", { name: "Disconnect Google" }),
    );
    expect(screen.getByText(/deletes the Google credentials/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
  });
});
