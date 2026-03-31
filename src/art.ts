import { C } from "./shared.js";

// Art-specific colour aliases for readability
const A = {
  body:    C.brightCyan,  // main body
  shadow:  C.cyan,        // shadow / underside
  cockpit: C.brightWhite, // cockpit windows
  dim:     C.dim,
  reset:   C.reset,
} as const;

// Pixel art: side-profile jet facing right.
// Each element is [text, colour] — colour "" means inherit / no colour change.
// Build rows as tagged segments so NO_COLOR can strip codes trivially.
type Seg = [string, string];
type Row = Seg[];

function r(...segs: Seg[]): Row { return segs; }
function s(text: string, col: string): Seg { return [text, col]; }

const PLANE: Row[] = [
  r(s("                ▄▄           ", A.shadow)),
  r(s("      ▄▄▄▄▄▄", A.shadow), s("████████▄", A.body), s("        ", "")),
  r(s("    ▄", A.shadow), s("████████████████████▄", A.body), s("   ", "")),
  r(s("   ", ""), s("█████", A.body), s(" ░░ ", A.cockpit), s("████████████████", A.body), s("▄▄▄", A.shadow)),
  r(s("    ▀", A.shadow), s("████████████████████▀", A.body), s("   ", "")),
  r(s("      ▀▀▀▀▀▀", A.shadow), s("████████▀", A.body), s("        ", "")),
  r(s("                ▀▀           ", A.shadow)),
];

function renderPlane(useColor: boolean): string {
  return PLANE.map((row) =>
    row.map(([text, col]) => (useColor && col ? col + text + A.reset : text)).join("")
  ).join("\n");
}

/**
 * Print the Flight pixel-art banner to stdout (or stderr for proxy).
 *
 * Skips output when:
 *  - the target stream is not a TTY (piped output)
 *  - FLIGHT_NO_BANNER=1 is set (for testing / scripting)
 */
// Pixel art: "FLIGHT" in blocky letters
const FLIGHT_TEXT: Row[] = [
  r(s("  ████  █      █  ▄████▄  █  █  ▀████▀ ", A.body)),
  r(s("  █     █      █  █    █  █  █    █  █  ", A.body)),
  r(s("  ███   █      █  █  ▄▄█  ████    █  █  ", A.body)),
  r(s("  █     █      █  █    █  █  █    █  █  ", A.body)),
  r(s("  █     ████  ▄█▄  ▀▀▀▀   █  █    █  █  ", A.shadow)),
];

// Pixel art: runway with plane taking off
const RUNWAY: Row[] = [
  r(s("                                     ▄▄   ", A.body)),
  r(s("                              ▄", A.shadow), s("██████▄  ", A.body)),
  r(s("         ·  ·  ·  ", A.dim), s("·≈≈≈", A.dim), s(" ▀██", A.body), s("░░", A.cockpit), s("█▀  ", A.body)),
  r(s("  ── ── ── ── ── ── ── ── ── ── ── ── ── ", A.cockpit)),
  r(s("▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓", A.shadow)),
  r(s("  ── ── ── ── ── ── ── ── ── ── ── ── ── ", A.dim)),
];

function renderRows(rows: Row[], useColor: boolean): string {
  return rows.map((row) =>
    row.map(([text, col]) => (useColor && col ? col + text + A.reset : text)).join("")
  ).join("\n");
}

function shouldShowBanner(stream: NodeJS.WriteStream): boolean {
  if (!stream.isTTY) return false;
  if (process.env.FLIGHT_NO_BANNER === "1") return false;
  return true;
}

function useColor(): boolean {
  return !process.env.NO_COLOR && !process.env.FORCE_COLOR?.startsWith("0");
}

/**
 * Print the Flight pixel-art banner to stdout (or stderr for proxy).
 *
 * Skips output when:
 *  - the target stream is not a TTY (piped output)
 *  - FLIGHT_NO_BANNER=1 is set (for testing / scripting)
 */
export function printBanner(command: string, opts: { toStderr?: boolean } = {}): void {
  const stream = opts.toStderr ? process.stderr : process.stdout;
  if (!shouldShowBanner(stream)) return;

  const color = useColor();
  const plane = renderPlane(color);
  const label = color
    ? `  ${A.dim}flight ${command}${A.reset}\n`
    : `  flight ${command}\n`;

  stream.write("\n" + plane + "\n" + label + "\n");
}

/**
 * Print the setup wizard banner: plane sprite + FLIGHT pixel art letters.
 */
export function printSetupBanner(): void {
  const stream = process.stdout;
  if (!shouldShowBanner(stream)) return;

  const color = useColor();
  const plane = renderPlane(color);
  const text = renderRows(FLIGHT_TEXT, color);
  const label = color
    ? `  ${A.dim}setup wizard${A.reset}\n`
    : `  setup wizard\n`;

  stream.write("\n" + plane + "\n" + text + "\n" + label + "\n");
}

/**
 * Print the completion banner: runway takeoff scene + success message.
 */
export function printCompletionBanner(): void {
  const stream = process.stdout;
  if (!shouldShowBanner(stream)) return;

  const color = useColor();
  const scene = renderRows(RUNWAY, color);
  const msg = color
    ? `\n  ${C.green}✓ Setup complete.${A.reset} ${A.dim}You're ready for takeoff.${A.reset}\n`
    : `\n  ✓ Setup complete. You're ready for takeoff.\n`;

  stream.write("\n" + scene + "\n" + msg + "\n");
}
