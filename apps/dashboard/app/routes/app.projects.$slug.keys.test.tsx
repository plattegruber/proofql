// @vitest-environment happy-dom
// Keys tab through createRoutesStub: the table renders every key with its
// prefix, kind, environment and state; minting shows the plaintext exactly
// once in the reveal panel (never in the table) until dismissed; revoking
// goes through the inline confirmation, not the browser's confirm().
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createRoutesStub, useActionData, useLoaderData } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import ProjectKeys, { type KeysActionData } from "./app.projects.$slug.keys";

type LoaderData = {
  project: { slug: string; allowedOrigins: string[] };
  keys: Array<{
    id: string;
    kind: "secret" | "publishable";
    environment: "live" | "test";
    prefix: string;
    createdAt: string;
    lastUsedAt: string | null;
    revokedAt: string | null;
  }>;
};

const PLAINTEXT = "pq_sk_live_Ab3xQ9zK2mN8pR4sT6vW1yB5dF7hJ0kL";

const loaderData: LoaderData = {
  project: {
    slug: "cedar-ridge-dental",
    allowedOrigins: ["http://localhost:8799"],
  },
  keys: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "secret",
      environment: "live",
      prefix: "pq_sk_live_cl3m",
      createdAt: "2026-09-01T10:00:00.000Z",
      lastUsedAt: "2026-09-28T17:00:00.000Z",
      revokedAt: null,
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "publishable",
      environment: "test",
      prefix: "pq_pk_test_GnDi",
      createdAt: "2026-08-15T10:00:00.000Z",
      lastUsedAt: null,
      revokedAt: "2026-09-20T10:00:00.000Z",
    },
  ],
};

function renderKeys(
  action: (args: { request: Request }) => Promise<KeysActionData>,
  data: LoaderData = loaderData,
) {
  const Stub = createRoutesStub([
    {
      path: "/app/projects/:slug/keys",
      loader: () => data,
      action: ({ request }) => action({ request }),
      Component: () => (
        <ProjectKeys
          loaderData={useLoaderData() as LoaderData}
          actionData={useActionData() as KeysActionData | undefined}
          params={{ slug: data.project.slug }}
          matches={[] as never}
        />
      ),
    },
  ]);
  return render(
    <Stub initialEntries={["/app/projects/cedar-ridge-dental/keys"]} />,
  );
}

describe("keys tab", () => {
  afterEach(cleanup);

  it("renders the key table with prefix, kind, environment and state", async () => {
    renderKeys(vi.fn());
    const table = await screen.findByRole("table");
    expect(table.textContent).toContain("pq_sk_live_cl3m");
    expect(table.textContent).toContain("pq_pk_test_GnDi");
    const rows = within(table);
    expect(rows.getByText("Secret")).toBeTruthy();
    expect(rows.getByText("Publishable")).toBeTruthy();
    expect(rows.getByText("2026-09-28")).toBeTruthy(); // last used
    expect(rows.getByText("Never")).toBeTruthy();
    expect(rows.getByText("Active")).toBeTruthy();
    expect(rows.getByText(/Revoked 2026-09-20/)).toBeTruthy();
    // A revoked key offers no revoke action; the active one does.
    expect(screen.getAllByRole("button", { name: "Revoke" })).toHaveLength(1);
    expect(screen.getByText("http://localhost:8799")).toBeTruthy();
    expect(screen.getByText("2 keys")).toBeTruthy();
  });

  it("explains both key kinds in one sentence each and keeps the voice", async () => {
    const { container } = renderKeys(vi.fn());
    await screen.findByRole("table");
    expect(screen.getByText(/Secret keys · pq_sk_/)).toBeTruthy();
    expect(screen.getByText(/Publishable keys · pq_pk_/)).toBeTruthy();
    expect(container.textContent).not.toContain("!");
  });

  it("shows the minted plaintext once in the reveal panel, never in the table", async () => {
    const action = vi.fn(
      async (): Promise<KeysActionData> => ({
        created: {
          plaintext: PLAINTEXT,
          prefix: "pq_sk_live_Ab3x",
          kind: "secret",
          environment: "live",
        },
      }),
    );
    renderKeys(action);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: "Create key" }));

    const code = await screen.findByTestId("plaintext-key");
    expect(code.textContent).toBe(PLAINTEXT);
    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/will not be shown again/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy key" })).toBeTruthy();
    expect(screen.getByRole("table").textContent).not.toContain(PLAINTEXT);

    // Dismissing hides it for good; the create form returns.
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByTestId("plaintext-key")).toBeNull();
    expect(screen.getByRole("button", { name: "Create key" })).toBeTruthy();
  });

  it("revokes through an inline confirmation", async () => {
    const seen: FormData[] = [];
    const action = vi.fn(async ({ request }: { request: Request }) => {
      seen.push(await request.formData());
      return {
        toast: { id: "t1", tone: "positive" as const, message: "Key revoked" },
      };
    });
    renderKeys(action);
    await screen.findByRole("table");

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    expect(
      screen.getByText(/Revoking pq_sk_live_cl3m… is permanent/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(action).toHaveBeenCalledTimes(1);
    expect(seen[0]?.get("intent")).toBe("revoke-key");
    expect(seen[0]?.get("keyId")).toBe("11111111-1111-4111-8111-111111111111");
  });
});
