/**
 * Text measurement without a browser.
 *
 * The server has no canvas to measure with, so widths are estimated from
 * per-character averages of the font the diagram embeds (IBM Plex Sans
 * Arabic). Estimates err wide: a box a little roomy is invisible, a label
 * running out of its box is the first thing a reader sees.
 */

function charWidth(char: string): number {
  if (char === ' ') return 0.28;
  if (/[؀-ۿ]/u.test(char)) return 0.52;
  if (/[A-Z]/.test(char)) return 0.66;
  if (/[a-z]/.test(char)) return 0.54;
  if (/[0-9]/.test(char)) return 0.58;
  if (/[.,:;'’()\-–—]/.test(char)) return 0.32;
  return 0.6;
}

export function textWidth(value: string, size: number): number {
  let total = 0;
  for (const char of value) total += charWidth(char);
  return total * size;
}

/**
 * Lines no wider than `max`, broken at spaces.
 *
 * A single word longer than the line is kept whole rather than split mid-word:
 * in Arabic a broken word is a different word.
 */
export function wrap(value: string, max: number, size: number, maxLines = 4): string[] {
  const words = value.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size) <= max || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);

  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
    return kept;
  }
  return lines;
}

/** Whether a string is written right to left, judged by its letters. */
export function isArabic(value: string): boolean {
  const arabic = (value.match(/[؀-ۿ]/gu) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  return arabic > latin;
}
