import { beforeEach, describe, expect, it } from "vitest";

import { initTabs } from "../src/scripts/tabs";

function setup(): HTMLElement {
  document.body.innerHTML = `
    <div role="tablist" aria-label="Pages">
      <button role="tab" id="t1" aria-controls="p1" aria-selected="true" tabindex="0">One</button>
      <button role="tab" id="t2" aria-controls="p2" aria-selected="false" tabindex="-1">Two</button>
      <button role="tab" id="t3" aria-controls="p3" aria-selected="false" tabindex="-1">Three</button>
    </div>
    <div role="tabpanel" id="p1" aria-labelledby="t1">1</div>
    <div role="tabpanel" id="p2" aria-labelledby="t2" hidden>2</div>
    <div role="tabpanel" id="p3" aria-labelledby="t3" hidden>3</div>`;
  const tablist = document.querySelector<HTMLElement>('[role="tablist"]');
  if (!tablist) throw new Error("no tablist");
  initTabs(tablist);
  return tablist;
}

function tab(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(id);
  return el;
}

function state(): string[] {
  return ["1", "2", "3"].map(
    (n) =>
      `${tab(`t${n}`).getAttribute("aria-selected")}/${tab(`t${n}`).tabIndex}/${tab(`p${n}`).hidden ? "hidden" : "shown"}`,
  );
}

function key(target: HTMLElement, name: string): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: name,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

describe("demo tabs", () => {
  beforeEach(() => {
    setup();
  });

  it("selects a tab on click and shows only its panel", () => {
    tab("t2").click();
    expect(state()).toEqual([
      "false/-1/hidden",
      "true/0/shown",
      "false/-1/hidden",
    ]);
  });

  it("moves with the arrow keys, wrapping, and focuses the new tab", () => {
    tab("t1").focus();
    expect(key(tab("t1"), "ArrowRight").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(tab("t2"));
    key(tab("t2"), "ArrowRight");
    key(tab("t3"), "ArrowRight");
    expect(document.activeElement).toBe(tab("t1"));
    key(tab("t1"), "ArrowLeft");
    expect(document.activeElement).toBe(tab("t3"));
    expect(state()).toEqual([
      "false/-1/hidden",
      "false/-1/hidden",
      "true/0/shown",
    ]);
  });

  it("jumps with Home and End", () => {
    key(tab("t1"), "End");
    expect(state()[2]).toBe("true/0/shown");
    key(tab("t3"), "Home");
    expect(state()[0]).toBe("true/0/shown");
  });

  it("ignores other keys", () => {
    expect(key(tab("t1"), "Enter").defaultPrevented).toBe(false);
    expect(key(tab("t1"), "ArrowDown").defaultPrevented).toBe(false);
    expect(state()[0]).toBe("true/0/shown");
  });
});
