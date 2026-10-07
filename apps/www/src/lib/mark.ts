/**
 * The ProofQL mark: a creature made of two code braces with two amber bar
 * eyes between them, from Claude Design ("Alive Logo",
 * project 23c56978-a71b-43af-bb74-e9bc6f1a3d4a).
 *
 * The braces are the `{` and `}` glyphs of JetBrains Mono ExtraBold (800),
 * version 2.211, outlined to SVG paths so the site loads no extra font and
 * nothing shifts when it would have arrived. JetBrains Mono is
 * Copyright 2020 The JetBrains Mono Project Authors
 * (https://github.com/JetBrains/JetBrainsMono), licensed under the SIL Open
 * Font License 1.1; the license text is public/fonts/OFL-jetbrains-mono.txt.
 *
 * Units are the font's (1000 per em). Paths are y-down with the baseline at
 * y = 0, exactly as the glyphs sit in text. The source lays the creature out
 * in CSS at `font-size: <size>; line-height: 1`, so each glyph box is 1em
 * tall with the baseline 0.86em from its top: JetBrains Mono's ascender is
 * 1020 and descender 300, so the half-leading is (1000 − 1320) / 2 = −160
 * and the baseline sits at −160 + 1020 = 860. Hence the viewBox below.
 * Every other measure is the source's, in em.
 */

export const UNITS_PER_EM = 1000;
export const GLYPH_ADVANCE = 600;
export const BASELINE = 860;
/** `viewBox` of one brace in a 0.6em × 1em box. */
export const BRACE_VIEWBOX = `0 -${BASELINE} ${GLYPH_ADVANCE} ${UNITS_PER_EM}`;

export const BRACE_LEFT =
  "M525 111L440 111Q386 111 343.5 88Q301 65 278.5 23.5Q256-18 260-74L270-219Q272-251 252-270Q232-289 200-289L75-289L75-429L200-429Q232-429 252-448.5Q272-468 270-499L260-650Q257-705 279-745.5Q301-786 343-808Q385-830 440-830L525-830L525-690L470-690Q442-690 425-676Q408-662 410-630L420-479Q424-424 382-391Q353-368 309-360Q353-353 382-330Q424-295 420-239L410-89Q409-62 426-45.5Q443-29 470-29L525-29L525 111Z";

export const BRACE_RIGHT =
  "M160 111L75 111L75-29L130-29Q157-29 174.5-45.5Q192-62 190-89L180-239Q176-295 219-330Q248-353 291-360Q248-368 219-391Q176-424 180-479L190-630Q192-662 175.5-676Q159-690 130-690L75-690L75-830L160-830Q215-830 257-808Q299-786 321.5-745.5Q344-705 340-650L330-499Q328-468 348.5-448.5Q369-429 400-429L525-429L525-289L400-289Q369-289 348.5-270Q328-251 330-219L340-74Q344-18 321.5 23.5Q299 65 257 88Q215 111 160 111Z";

/** The source's layout, in em (font-size = the creature's size). */
export const LAYOUT = {
  braceWidth: 0.6,
  /** The eyes' row: `padding: 0.2em 0.05em 0; gap: 0.09em`. */
  eyesPadTop: 0.2,
  eyesPadX: 0.05,
  eyesGap: 0.09,
  eyeWidth: 0.105,
  eyeHeight: 0.3,
  eyeRadius: 0.06,
  /** Shadow: 62% of the stage wide, 14px tall and 10px below at 220px. */
  shadowWidth: 0.62,
  shadowHeight: 14 / 220,
  shadowGap: 10 / 220,
  shadowBlur: 4 / 220,
} as const;

/** Stage width in em: two braces and the eyes' row. */
export const STAGE_WIDTH =
  2 * LAYOUT.braceWidth +
  2 * LAYOUT.eyesPadX +
  2 * LAYOUT.eyeWidth +
  LAYOUT.eyesGap;

/** Theme colours from the source: Paper (light) and Obsidian (dark). */
export const THEMES = {
  paper: { brace: "#090D16", eye: "#F59E0B", shadow: "#090D16", alpha: 0.14 },
  obsidian: { brace: "#FAF9F6", eye: "#F59E0B", shadow: "#000000", alpha: 0.6 },
} as const;

/**
 * The static mark as one SVG document (favicon, OG image): braces and eyes
 * in font units, cropped to the ink, on an optional background.
 */
export function markSvg(options: {
  brace: string;
  eye: string;
  background?: string;
  /** Extra space around the ink, in font units. */
  pad?: number;
  square?: boolean;
}): string {
  const u = (em: number) => Math.round(em * UNITS_PER_EM);
  const eyeY = u(LAYOUT.eyesPadTop);
  const eyeL = u(LAYOUT.braceWidth + LAYOUT.eyesPadX);
  const eyeR = u(
    LAYOUT.braceWidth + LAYOUT.eyesPadX + LAYOUT.eyeWidth + LAYOUT.eyesGap,
  );
  const ew = u(LAYOUT.eyeWidth);
  const eh = u(LAYOUT.eyeHeight);
  const er = u(LAYOUT.eyeRadius);
  const rightX = u(STAGE_WIDTH - LAYOUT.braceWidth);
  // Ink: x 75…(rightX + 525), y from the top of the braces (860 − 830 = 30)
  // to their bottom (860 + 111 = 971).
  const pad = options.pad ?? 0;
  let x = 75 - pad;
  let y = 30 - pad;
  let w = rightX + 525 - 75 + 2 * pad;
  let h = 971 - 30 + 2 * pad;
  if (options.square) {
    const side = Math.max(w, h);
    x -= (side - w) / 2;
    y -= (side - h) / 2;
    w = side;
    h = side;
  }
  const bg = options.background
    ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${options.background}"/>`
    : "";
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${w} ${h}">`,
    "<title>ProofQL</title>",
    bg,
    `<g fill="${options.brace}">`,
    `<path transform="translate(0 ${BASELINE})" d="${BRACE_LEFT}"/>`,
    `<path transform="translate(${rightX} ${BASELINE})" d="${BRACE_RIGHT}"/>`,
    "</g>",
    `<g fill="${options.eye}">`,
    `<rect x="${eyeL}" y="${eyeY}" width="${ew}" height="${eh}" rx="${er}"/>`,
    `<rect x="${eyeR}" y="${eyeY}" width="${ew}" height="${eh}" rx="${er}"/>`,
    "</g>",
    "</svg>",
  ].join("");
}
