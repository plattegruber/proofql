/**
 * The hero creature, alive: a vanilla port of the Claude Design source's
 * animation loop ("Alive Logo"). Same springs, blink, wander, bounce curve,
 * happy state and startle; only the plumbing differs:
 *
 * - requestAnimationFrame runs only while the creature is on screen
 *   (IntersectionObserver) and the tab is visible (visibilitychange), and
 *   its pointer listeners exist only while it runs. All are passive.
 * - The eyes' centre comes from a cached rect, refreshed after a scroll or
 *   resize, instead of a layout read every frame.
 * - Touch: a tap startles it, and lifting the finger ends tracking, so the
 *   happy (hover) state never sticks.
 * - prefers-reduced-motion: reduce leaves the static mark (no loop at all),
 *   and switching it on mid-way stops and resets the creature.
 *
 * The markup is src/components/Creature.astro; everything is decorative
 * (aria-hidden).
 */

import {
  BOUNCE_MS,
  blinkAmount,
  bounceCurve,
  eyeScaleY,
  nextBlink,
  SPRINGS,
  spring,
} from "./creature-math";

const FOLLOW_CURSOR = true;
const AUTO_BOUNCE = true;
const BOUNCE_EVERY_S = 6;

interface Parts {
  root: HTMLElement;
  stage: HTMLElement;
  braceL: HTMLElement;
  braceR: HTMLElement;
  eyeL: HTMLElement;
  eyeR: HTMLElement;
  shadow: HTMLElement | null;
}

function parts(root: HTMLElement): Parts | null {
  const q = (sel: string) => root.querySelector<HTMLElement>(sel);
  const stage = q(".creature-stage");
  const braceL = q(".creature-brace-l");
  const braceR = q(".creature-brace-r");
  const eyes = root.querySelectorAll<HTMLElement>(".creature-eye");
  const [eyeL, eyeR] = [eyes[0], eyes[1]];
  if (!stage || !braceL || !braceR || !eyeL || !eyeR) return null;
  return {
    root,
    stage,
    braceL,
    braceR,
    eyeL,
    eyeR,
    shadow: q(".creature-shadow"),
  };
}

export function animateCreature(root: HTMLElement): void {
  const p = parts(root);
  if (!p) return;
  const win = root.ownerDocument.defaultView;
  if (!win) return;
  const doc = root.ownerDocument;
  const reduce = win.matchMedia("(prefers-reduced-motion: reduce)");

  const t0 = performance.now();
  const m = { x: 0, y: 0, active: false, last: 0 };
  const s = { lx: 0, ly: 0, vx: 0, vy: 0, hover: 0, vh: 0, surp: 0, vs: 0 };
  let wander = { x: 0, y: 0, next: t0 + 800 };
  const blink = { start: -1e9, double: false, next: t0 + 1500 };
  const bounce = { start: -1e9, h: 1, next: t0 + 2500 };
  let last = t0;
  let raf = 0;
  let running = false;
  let onScreen = false;

  // The creature's size is its font-size (CSS sets it responsively).
  let size = 0;
  let cx = 0;
  let cy = 0;
  let rectDirty = true;
  const measure = () => {
    const r = p.root.getBoundingClientRect();
    size = Number.parseFloat(win.getComputedStyle(p.stage).fontSize) || 1;
    // The eyes' row is centred in the stage; the source aims at 35% of its
    // 1em height.
    cx = r.left + r.width / 2;
    cy = r.top + size * 0.35;
    rectDirty = false;
  };
  const dirty = () => {
    rectDirty = true;
  };

  const onMove = (e: PointerEvent) => {
    m.x = e.clientX;
    m.y = e.clientY;
    m.active = true;
    m.last = performance.now();
  };
  const onLeave = () => {
    m.active = false;
  };
  const onDown = (e: PointerEvent) => {
    onMove(e);
    s.vs += 0.55;
    const t = performance.now();
    if (t - bounce.start > 700) {
      bounce.start = t;
      bounce.h = 1.5;
    }
    blink.next = t + 900;
  };
  // A finger that lifts is gone: no lingering gaze or happy squint.
  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") m.active = false;
  };

  const passive = { passive: true } as const;
  const listen = (on: boolean) => {
    const method = on ? "addEventListener" : "removeEventListener";
    win[method]("pointermove", onMove as EventListener, passive);
    win[method]("pointerdown", onDown as EventListener, passive);
    win[method]("pointerup", onUp as EventListener, passive);
    win[method]("pointercancel", onUp as EventListener, passive);
    win[method]("scroll", dirty, passive);
    win[method]("resize", dirty, passive);
    doc.documentElement[method]("pointerleave", onLeave, passive);
  };

  const loop = (now: number) => {
    raf = win.requestAnimationFrame(loop);
    const dt = Math.min(3, (now - last) / 16.67);
    last = now;
    if (rectDirty) measure();

    let tx: number;
    let ty: number;
    let near = 0;
    const tracking = FOLLOW_CURSOR && m.active && now - m.last < 4000;
    if (tracking) {
      const dx = m.x - cx;
      const dy = m.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      const f = Math.min(1, d / (size * 1.6));
      tx = (dx / d) * f;
      ty = (dy / d) * f;
      near = d < size * 0.75 ? 1 : 0;
    } else {
      if (now > wander.next) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.random() < 0.3 ? 0 : 0.5 + Math.random() * 0.5;
        wander = {
          x: Math.cos(a) * rr,
          y: Math.sin(a) * rr * 0.7,
          next: now + 900 + Math.random() * 2000,
        };
      }
      tx = wander.x;
      ty = wander.y;
    }

    if (now > blink.next) Object.assign(blink, nextBlink(now));
    const shut = blinkAmount(now - blink.start, blink.double);

    if (AUTO_BOUNCE && now > bounce.next) {
      if (now - bounce.start > 1000) {
        bounce.start = now;
        bounce.h = 1;
      }
      bounce.next = now + BOUNCE_EVERY_S * 1000 * (0.75 + Math.random() * 0.5);
    }
    const bc = bounceCurve((now - bounce.start) / BOUNCE_MS, bounce.h);
    ty += bc.up;

    [s.lx, s.vx] = spring(s.lx, s.vx, tx, ...SPRINGS.gaze, dt);
    [s.ly, s.vy] = spring(
      s.ly,
      s.vy,
      Math.max(-1, Math.min(1, ty)),
      ...SPRINGS.gaze,
      dt,
    );
    [s.hover, s.vh] = spring(s.hover, s.vh, near, ...SPRINGS.hover, dt);
    [s.surp, s.vs] = spring(s.surp, s.vs, 0, ...SPRINGS.surprise, dt);

    const em = size;
    const sp = Math.max(0, s.surp);
    const hv = Math.max(0, Math.min(1, s.hover));
    const breathe = Math.sin(now / 900) * 0.012;
    const lift = bc.y * size * 0.22;

    p.stage.style.transform = `translateY(${lift}px) scale(${bc.sx * (1 - breathe * 0.5)}, ${bc.sy * (1 + breathe)})`;

    const eyeSY = eyeScaleY(shut, hv, sp);
    const eyeSX = 1 + 0.25 * sp + 0.08 * hv;
    const ex = s.lx * em * 0.075;
    const ey = s.ly * em * 0.075;
    const eyeY = ey - hv * em * 0.03;
    const eyeRot = s.lx * -4;
    p.eyeL.style.transform = `translate(${ex * (s.lx > 0 ? 1.1 : 0.85)}px, ${eyeY}px) rotate(${eyeRot}deg) scale(${eyeSX}, ${eyeSY})`;
    p.eyeR.style.transform = `translate(${ex * (s.lx < 0 ? 1.1 : 0.85)}px, ${eyeY}px) rotate(${eyeRot}deg) scale(${eyeSX}, ${eyeSY})`;

    const spread = (sp * 0.09 - hv * 0.025) * em;
    const wiggle = Math.sin(now / 85) * hv * 4;
    const tilt = s.lx * 6;
    const par = s.lx * em * 0.02;
    const braceY = s.ly * em * 0.015;
    p.braceL.style.transform = `translate(${-spread + par}px, ${braceY}px) rotate(${tilt + wiggle}deg)`;
    p.braceR.style.transform = `translate(${spread + par}px, ${braceY}px) rotate(${tilt - wiggle}deg)`;

    if (p.shadow) {
      const air = Math.min(1, -bc.y);
      p.shadow.style.transform = `translateX(${par * 0.5}px) scaleX(${(1 - 0.45 * air) * bc.sx})`;
      // The theme's shadow alpha is on ::before; this multiplies it.
      p.shadow.style.opacity = String(1 - 0.6 * air);
    }
  };

  const reset = () => {
    for (const el of [p.stage, p.braceL, p.braceR, p.eyeL, p.eyeR, p.shadow]) {
      if (el) {
        el.style.transform = "";
        el.style.opacity = "";
      }
    }
  };

  const update = () => {
    const should = onScreen && !doc.hidden && !reduce.matches;
    if (should === running) return;
    running = should;
    if (should) {
      last = performance.now();
      rectDirty = true;
      listen(true);
      raf = win.requestAnimationFrame(loop);
    } else {
      win.cancelAnimationFrame(raf);
      listen(false);
      m.active = false;
      if (reduce.matches) reset();
    }
  };

  new IntersectionObserver((entries) => {
    for (const entry of entries) onScreen = entry.isIntersecting;
    update();
  }).observe(root);
  doc.addEventListener("visibilitychange", update, passive);
  reduce.addEventListener("change", update);
}
