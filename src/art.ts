// ANSI colour helpers
const C = {
  cyan:    "\x1b[96m",  // bright cyan — main body
  blue:    "\x1b[36m",  // regular cyan — shadow / underside
  white:   "\x1b[97m",  // cockpit windows
  dim:     "\x1b[2m",   // dimmed text (command label)
  reset:   "\x1b[0m",
} as const;

// Pixel art: side-profile jet facing right.
// Each element is [text, colour] — colour "" means inherit / no colour change.
// Build rows as tagged segments so NO_COLOR can strip codes trivially.
type Seg = [string, string];
type Row = Seg[];

function r(...segs: Seg[]): Row { return segs; }
function s(text: string, col: string): Seg { return [text, col]; }

const PLANE: Row[] = [
  r(s("                ▄▄           ", C.blue)),
  r(s("      ▄▄▄▄▄▄", C.blue), s("████████▄", C.cyan), s("        ", "")),
  r(s("    ▄", C.blue), s("████████████████████▄", C.cyan), s("   ", "")),
  r(s("   ", ""), s("█████", C.cyan), s(" ░░ ", C.white), s("████████████████", C.cyan), s("▄▄▄", C.blue)),
  r(s("    ▀", C.blue), s("████████████████████▀", C.cyan), s("   ", "")),
  r(s("      ▀▀▀▀▀▀", C.blue), s("████████▀", C.cyan), s("        ", "")),
  r(s("                ▀▀           ", C.blue)),
];

function renderPlane(useColor: boolean): string {
  return PLANE.map((row) =>
    row.map(([text, col]) => (useColor && col ? col + text + C.reset : text)).join("")
  ).join("\n");
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
  if (!stream.isTTY) return;
  if (process.env.FLIGHT_NO_BANNER === "1") return;

  const useColor = !process.env.NO_COLOR && !process.env.FORCE_COLOR?.startsWith("0");

  const plane = renderPlane(useColor);
  const label = useColor
    ? `  ${C.dim}flight ${command}${C.reset}\n`
    : `  flight ${command}\n`;

  stream.write("\n" + plane + "\n" + label + "\n");
}
