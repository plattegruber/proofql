import { beforeEach, describe, expect, it } from "vitest";

import { initMenu } from "../src/scripts/menu";

function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(id);
  return found;
}

const expanded = (): string | null =>
  el("toggle").getAttribute("aria-expanded");

describe("header menu", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <nav aria-label="Main">
        <button id="toggle" type="button" aria-expanded="false" aria-controls="links">Menu</button>
        <ul id="links"><li><a id="docs" href="#">Docs</a></li></ul>
      </nav>
      <p id="outside">Page</p>`;
    initMenu(el("toggle"));
  });

  it("opens and closes from the toggle", () => {
    el("toggle").click();
    expect(expanded()).toBe("true");
    el("toggle").click();
    expect(expanded()).toBe("false");
  });

  it("closes on Escape and returns focus to the toggle", () => {
    el("toggle").click();
    el("docs").focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
    expect(expanded()).toBe("false");
    expect(document.activeElement).toBe(el("toggle"));
  });

  it("closes on a click outside, not on one inside", () => {
    el("toggle").click();
    el("links").click();
    expect(expanded()).toBe("true");
    el("outside").click();
    expect(expanded()).toBe("false");
  });
});
