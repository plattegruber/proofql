import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BRACE_LEFT, BRACE_RIGHT, STAGE_WIDTH } from "../src/lib/mark";
import {
  blinkAmount,
  bounceCurve,
  eyeScaleY,
  nextBlink,
  spring,
} from "../src/scripts/creature-math";

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe("bounceCurve", () => {
  it("rests outside [0, 1]", () => {
    for (const t of [-0.1, 1.01]) {
      expect(bounceCurve(t, 1)).toEqual({ y: 0, sx: 1, sy: 1, up: 0 });
    }
  });

  it("squashes in anticipation, fully at t = 0.15", () => {
    const f = bounceCurve(0.1499999, 1);
    close(f.y, 0);
    close(f.sx, 1.08);
    close(f.sy, 0.88);
    close(f.up, -0.3);
  });

  it("peaks one jump high at the middle of the flight, unstretched", () => {
    const f = bounceCurve(0.35, 1);
    close(f.y, -1);
    close(f.sx, 1);
    close(f.sy, 1);
    expect(bounceCurve(0.3, 1).up).toBe(-0.7); // looking up on the way up
    expect(bounceCurve(0.4, 1).up).toBe(0.6); // down for the landing
  });

  it("scales the jump and the squash with the height (the startle is 1.5)", () => {
    close(bounceCurve(0.35, 1.5).y, -1.5);
    close(bounceCurve(0.635, 1.5).sy, 1 - 0.15 * 1.5);
  });

  it("squashes hardest mid-landing, then jiggles back to rest", () => {
    const land = bounceCurve(0.635, 1);
    close(land.sx, 1.11);
    close(land.sy, 0.85);
    close(land.up, 0.5);
    const end = bounceCurve(1, 1);
    close(end.sx, 1);
    close(end.sy, 1);
  });

  it("never jumps in height at the phase boundaries", () => {
    // Scale snaps from squash to stretch at takeoff and landing by design;
    // the height is continuous.
    for (const t of [0.15, 0.55, 0.72]) {
      const a = bounceCurve(t - 1e-7, 1);
      const b = bounceCurve(t + 1e-7, 1);
      expect(Math.abs(a.y - b.y)).toBeLessThan(1e-4);
    }
  });
});

describe("spring", () => {
  it("is the source's step: v += (target − x)·k·dt; v *= d^dt; x += v·dt", () => {
    const [x, v] = spring(0, 0, 1, 0.09, 0.72, 1);
    close(v, 0.09 * 0.72);
    close(x, 0.09 * 0.72);
  });

  it("settles on its target", () => {
    let x = 0;
    let v = 0;
    for (let i = 0; i < 600; i++) [x, v] = spring(x, v, 1, 0.09, 0.72, 1);
    close(x, 1);
    close(v, 0);
  });

  it("is roughly frame-rate independent (60 Hz vs 120 Hz)", () => {
    let a: [number, number] = [0, 0];
    let b: [number, number] = [0, 0];
    for (let i = 0; i < 30; i++) a = spring(...a, 1, 0.09, 0.72, 1);
    for (let i = 0; i < 60; i++) b = spring(...b, 1, 0.09, 0.72, 0.5);
    expect(Math.abs(a[0] - b[0])).toBeLessThan(0.05);
  });
});

describe("blink", () => {
  it("closes on a half-sine over 150 ms", () => {
    close(blinkAmount(0, false), 0);
    close(blinkAmount(75, false), 1);
    close(blinkAmount(150, false), 0);
    close(blinkAmount(300, false), 0);
  });

  it("blinks again 230 ms later when double", () => {
    close(blinkAmount(305, true), 1);
    close(blinkAmount(305, false), 0);
  });

  it("never shuts the eyes below 8%", () => {
    expect(eyeScaleY(1, 1, 0)).toBe(0.08);
    close(eyeScaleY(0, 0, 0), 1);
    close(eyeScaleY(0, 1, 0), 0.5); // happy squint
    close(eyeScaleY(0, 0, 1), 1.35); // startle
  });

  it("schedules the next blink 2.2–6 s out, a quarter of them double", () => {
    expect(nextBlink(1000, () => 0)).toEqual({
      start: 1000,
      double: true,
      next: 3200,
    });
    expect(nextBlink(1000, () => 0.999).double).toBe(false);
    expect(nextBlink(0, () => 0.999).next).toBeCloseTo(5996.2, 1);
  });
});

describe("mark", () => {
  it("is two braces and the eyes' row, 1.6em wide", () => {
    close(STAGE_WIDTH, 1.6);
  });

  it("the favicon is drawn from the same outlines", () => {
    const favicon = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../public/favicon.svg"),
      "utf8",
    );
    expect(favicon).toContain(BRACE_LEFT);
    expect(favicon).toContain(BRACE_RIGHT);
  });
});
