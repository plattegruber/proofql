// The flash cookie round-trips through set → read → cleared, and refuses to
// run on a dev-only secret outside the local environment.
import { describe, expect, it } from "vitest";

import { readFlash, setFlash } from "./flash.server";

const local = { ENVIRONMENT: "local" };

describe("flash", () => {
  it("carries a message across one request and clears itself", async () => {
    const headers = await setFlash(local, {
      tone: "positive",
      message: "Settings saved",
    });
    const cookie = headers.get("Set-Cookie");
    expect(cookie).toContain("__pq_flash=");

    const request = new Request("https://dash.test/app", {
      headers: { Cookie: cookie?.split(";")[0] ?? "" },
    });
    const first = await readFlash(local, request);
    expect(first.flash).toMatchObject({
      tone: "positive",
      message: "Settings saved",
    });
    expect(first.flash?.id).toMatch(/[0-9a-f-]{36}/);
    expect(first.headers?.get("Set-Cookie")).toContain("__pq_flash=");

    // The clearing cookie, replayed, carries nothing.
    const cleared = first.headers?.get("Set-Cookie")?.split(";")[0] ?? "";
    const second = await readFlash(
      local,
      new Request("https://dash.test/app", { headers: { Cookie: cleared } }),
    );
    expect(second.flash).toBeNull();
    expect(second.headers).toBeUndefined();
  });

  it("refuses to run without SESSION_SECRET outside local", async () => {
    await expect(
      setFlash({ ENVIRONMENT: "preview" }, { tone: "neutral", message: "x" }),
    ).rejects.toThrow(/SESSION_SECRET/);
    await expect(
      setFlash(
        { ENVIRONMENT: "preview", SESSION_SECRET: "s3cret" },
        { tone: "neutral", message: "x" },
      ),
    ).resolves.toBeInstanceOf(Headers);
  });
});
