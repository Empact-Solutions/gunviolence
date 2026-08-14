// Shared helpers: rolling averages and rate calculations computed client-side.
// Source data ships as raw monthly counts + population; nothing here is pre-smoothed.

const WINDOW = 12;

// Categorical palette (validated for CVD-safe adjacent contrast — see the
// project's dataviz skill: slots assigned in fixed order, never cycled).
// Victims/Perpetrators is the recurring pair across every chart on this site;
// `neutral` is the third slot, used only where a third category is needed
// (e.g. "no child or youth involved").
const PALETTE = {
  victim: "#2a78d6", // blue — categorical slot 1
  perp: "#eb6834", // orange — categorical slot 2
  neutral: "#1baf7a", // aqua — categorical slot 3
};

/**
 * A single-hue, light-to-dark sequential ramp for choropleths, built from one
 * target hue rather than a stock d3 scheme — keeps the map's colors in the
 * same family as the categorical palette above.
 */
function sequentialRamp(hex, steps = 7) {
  const light = d3.hsl(hex);
  light.l = 0.93;
  light.s = Math.min(light.s, 0.45);
  const interpolate = d3.interpolateHcl(light.formatHex(), hex);
  return d3.range(steps).map((i) => interpolate(i / (steps - 1)));
}

/**
 * Trailing N-month rolling mean. Returns null for the first (window - 1) points,
 * matching the original notebook's "12-month rolling average" convention.
 */
function rollingMean(values, window = WINDOW) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

/** Trailing N-month rolling sum. Returns null for the first (window - 1) points. */
function rollingSum(values, window = WINDOW) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    if (i >= window - 1) out[i] = sum;
  }
  return out;
}

/** Rate per 100,000 population. */
function toRate(count, population) {
  if (!population) return null;
  return (count / population) * 100000;
}

/**
 * Given an array of rows sorted by month and a value accessor, attach a
 * rolling-average series (of counts, or of rates if `population` accessor given).
 */
function addRollingSeries(rows, valueKey, { populationKey = null, window = WINDOW } = {}) {
  const raw = rows.map((d) =>
    populationKey ? toRate(d[valueKey], d[populationKey]) : d[valueKey]
  );
  const rolled = rollingMean(raw, window);
  return rows.map((d, i) => ({ ...d, __raw: raw[i], __rolled: rolled[i] }));
}

/**
 * Parse an ISO "YYYY-MM-DD" date string as a *local* date. `new Date(str)`
 * parses bare date strings as UTC midnight, which displays as the previous
 * day in any negative-UTC-offset timezone — this avoids that off-by-one.
 */
function parseMonth(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatMonth(date) {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short" });
}

function pct(a, b) {
  return ((b - a) / a) * 100;
}

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
  return res.json();
}
