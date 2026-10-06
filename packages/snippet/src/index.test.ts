/**
 * The entry point end to end under jsdom: the script tag is read, the global
 * is exposed, the first scan waits for DOMContentLoaded, and SPAs can re-scan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixtureResponse, stubFetch } from "./test/fixture.js";

function setReadyState(state: DocumentReadyState): void {
  Object.defineProperty(document, "readyState", {
    value: state,
    configurable: true,
  });
}

function installScript(attrs: Record<string, string>): HTMLScriptElement {
  const script = document.createElement("script");
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  document.head.append(script);
  Object.defineProperty(document, "currentScript", {
    value: script,
    configurable: true,
  });
  return script;
}

function host(attrs: Record<string, string> = {}): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-proofql", "");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

async function load(): Promise<void> {
  vi.resetModules();
  await import("./index.js");
}

/** Let the fetch/render microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

let fetchStub: ReturnType<typeof stubFetch>;

beforeEach(() => {
  vi.spyOn(console, "debug").mockImplementation(() => {});
  fetchStub = stubFetch({ body: fixtureResponse() });
  vi.stubGlobal("fetch", fetchStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  Object.defineProperty(document, "currentScript", {
    value: null,
    configurable: true,
  });
  setReadyState("complete");
  delete (window as unknown as { ProofQL?: unknown }).ProofQL;
});

type Global = {
  render(root?: Element | Document): Promise<void>;
  version: string;
};
const api = () => (window as unknown as { ProofQL: Global }).ProofQL;

describe("v1.js", () => {
  it("exposes window.ProofQL and scans immediately when the DOM is ready", async () => {
    installScript({
      "data-key": "pq_pk_test_abc",
      "data-api": "http://localhost:8797",
    });
    const el = host({ "data-query": "implants" });
    setReadyState("interactive");

    await load();
    expect(api().version).toBe("test");
    expect(typeof api().render).toBe("function");
    await settle();

    expect(fetchStub.calls).toEqual([
      "http://localhost:8797/v1/query?key=pq_pk_test_abc&q=implants&limit=3",
    ]);
    expect(el.querySelectorAll(".pq-item")).toHaveLength(3);
  });

  it("waits for DOMContentLoaded while the document is still loading", async () => {
    installScript({ "data-key": "pq_pk_test_abc" });
    setReadyState("loading");
    await load();
    await settle();
    expect(fetchStub.calls).toHaveLength(0);

    // Markup parsed after the (async) script ran is still picked up.
    const el = host();
    document.dispatchEvent(new Event("DOMContentLoaded"));
    await settle();
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0]).toContain(
      "https://api.proofql.dev/v1/query?key=pq_pk_test_abc&limit=3",
    );
    expect(el.querySelector(".pq-list")).not.toBeNull();
  });

  it("ProofQL.render() re-scans for elements added later (SPAs)", async () => {
    installScript({ "data-key": "pq_pk_test_abc" });
    const first = host();
    await load();
    await settle();
    expect(fetchStub.calls).toHaveLength(1);

    const second = host({ "data-query": "kids" });
    await api().render();
    expect(fetchStub.calls).toHaveLength(2);
    expect(fetchStub.calls[1]).toContain("q=kids");
    expect(first.querySelectorAll(".pq-list")).toHaveLength(1);
    expect(second.querySelectorAll(".pq-list")).toHaveLength(1);

    // Scoped to a root.
    const wrapper = document.createElement("section");
    const third = document.createElement("div");
    third.setAttribute("data-proofql", "");
    wrapper.append(third);
    document.body.append(wrapper);
    await api().render(wrapper);
    expect(fetchStub.calls).toHaveLength(3);
    expect(third.querySelector(".pq-list")).not.toBeNull();
  });

  it("does nothing, quietly, without a data-key", async () => {
    installScript({});
    const el = host();
    const before = el.outerHTML;
    await load();
    await api().render();
    expect(fetchStub.calls).toHaveLength(0);
    expect(el.outerHTML).toBe(before);
    expect(console.debug).toHaveBeenCalledTimes(1);
  });

  it("never throws into the host page", async () => {
    installScript({ "data-key": "pq_pk_test_abc" });
    host();
    vi.stubGlobal("fetch", () => {
      throw new Error("boom");
    });
    await expect(load()).resolves.toBeUndefined();
    await expect(api().render()).resolves.toBeUndefined();
    const spy = vi
      .spyOn(document, "querySelectorAll")
      .mockImplementation(() => {
        throw new Error("DOM exploded");
      });
    await expect(api().render()).resolves.toBeUndefined();
    spy.mockRestore();
  });
});
