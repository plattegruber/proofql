/**
 * The nav mark's only motion: an occasional blink (sometimes double), on
 * the source's schedule (2.2–6 s apart, a quarter of them double). The blink
 * itself is a CSS animation (Creature.astro), so this is a timer and a
 * class, with no animation frame. Nothing is scheduled under
 * prefers-reduced-motion or while the tab is hidden.
 */

import { nextBlink } from "./creature-math";

export function blinkCreature(root: HTMLElement): void {
  const win = root.ownerDocument.defaultView;
  if (!win) return;
  const reduce = win.matchMedia("(prefers-reduced-motion: reduce)");
  let timer = 0;

  root.addEventListener(
    "animationend",
    () => root.classList.remove("is-blinking", "is-blinking-double"),
    { passive: true },
  );

  const schedule = () => {
    win.clearTimeout(timer);
    if (reduce.matches || root.ownerDocument.hidden) return;
    const b = nextBlink(0);
    timer = win.setTimeout(() => {
      root.classList.add(b.double ? "is-blinking-double" : "is-blinking");
      schedule();
    }, b.next);
  };

  root.ownerDocument.addEventListener("visibilitychange", schedule, {
    passive: true,
  });
  reduce.addEventListener("change", schedule);
  // The source's first blink comes 1.5 s in.
  timer = win.setTimeout(() => {
    if (!reduce.matches && !root.ownerDocument.hidden) {
      root.classList.add("is-blinking");
    }
    schedule();
  }, 1500);
}
