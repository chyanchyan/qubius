/* Text size is a percentage of the normal 13px root size. These helpers hold
   the pure logic so it can be tested outside the browser. */
export const FONT_PERCENT_MIN = 60;
export const FONT_PERCENT_MAX = 300;
export const FONT_PERCENT_STEP = 10;
export const FONT_PERCENT_KEY = "qubius:font-percent";

const DEFAULT_FONT_PERCENT = 100;

/** Coerce anything (stored string, number, null, junk) into a legal percent. */
export function normalizeFontPercent(value: unknown): number {
  let numeric: number;
  if (typeof value === "number") {
    numeric = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    numeric = Number(value);
  } else {
    return DEFAULT_FONT_PERCENT;
  }
  if (!Number.isFinite(numeric)) return DEFAULT_FONT_PERCENT;
  const clamped = Math.min(FONT_PERCENT_MAX, Math.max(FONT_PERCENT_MIN, numeric));
  return Math.round(clamped / FONT_PERCENT_STEP) * FONT_PERCENT_STEP;
}

/** Step one notch and clamp, normalizing the current value first. */
export function stepFontPercent(current: number, direction: 1 | -1): number {
  const normalized = normalizeFontPercent(current);
  return normalizeFontPercent(normalized + direction * FONT_PERCENT_STEP);
}

/** Read the saved percent, falling back to 100 when storage is unavailable. */
export function readStoredFontPercent(storage?: Pick<Storage, "getItem">): number {
  try {
    const target = storage ?? window.localStorage;
    return normalizeFontPercent(target.getItem(FONT_PERCENT_KEY));
  } catch {
    // Storage can be unavailable; fall back to the normal size.
    return DEFAULT_FONT_PERCENT;
  }
}

/** The value written to the --font-scale CSS variable. */
export function fontPercentToScale(percent: number): number {
  return percent / 100;
}
