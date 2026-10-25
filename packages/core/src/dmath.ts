/**
 * Trigonometry that gives the same bits on every machine.
 *
 * JavaScript engines may compute Math.sin, Math.atan2 and friends differently per platform
 * (V8 on macOS ARM rounds some atan2 results differently from Linux and Windows), and a
 * last-digit difference is enough to break a golden hash. These use only +, -, *, / and
 * Math.sqrt, which IEEE 754 requires to be correctly rounded everywhere, so anything the
 * simulation computes with them is identical on every machine.
 */

const PI = Math.PI;
const HALF_PI = PI / 2;
const QUARTER_PI = PI / 4;
const SQRT3 = Math.sqrt(3);
/** tan(π/12): below it, the atan series converges fast. */
const TAN_PI_12 = 2 - SQRT3;

/** sin on [-π/4, π/4], Taylor series to x^19 (error far below a double's precision there). */
function sinKernel(x: number): number {
  const x2 = x * x;
  let term = x;
  let sum = x;
  for (let n = 1; n <= 9; n++) {
    term *= -x2 / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

/** cos on [-π/4, π/4], Taylor series to x^20. */
function cosKernel(x: number): number {
  const x2 = x * x;
  let term = 1;
  let sum = 1;
  for (let n = 1; n <= 10; n++) {
    term *= -x2 / ((2 * n - 1) * (2 * n));
    sum += term;
  }
  return sum;
}

/** x reduced to [-π/4, π/4] and its quadrant (multiples of π/2). */
function reduce(x: number): { r: number; quadrant: number } {
  const k = Math.round(x / HALF_PI);
  return { r: x - k * HALF_PI, quadrant: ((k % 4) + 4) % 4 };
}

export function sin(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const { r, quadrant } = reduce(x);
  return quadrant === 0 ? sinKernel(r) : quadrant === 1 ? cosKernel(r) : quadrant === 2 ? -sinKernel(r) : -cosKernel(r);
}

export function cos(x: number): number {
  if (!Number.isFinite(x)) return NaN;
  const { r, quadrant } = reduce(x);
  return quadrant === 0 ? cosKernel(r) : quadrant === 1 ? -sinKernel(r) : quadrant === 2 ? -cosKernel(r) : sinKernel(r);
}

/** atan on [0, 1]. */
function atanUnit(x: number): number {
  // Shift above tan(π/12) down by π/6: atan(x) = π/6 + atan((x√3 - 1) / (x + √3)).
  if (x > TAN_PI_12) return PI / 6 + atanSeries((x * SQRT3 - 1) / (x + SQRT3));
  return atanSeries(x);
}

/** atan for |x| ≤ tan(π/12) ≈ 0.268: x - x³/3 + x⁵/5 - ..., to x^29. */
function atanSeries(x: number): number {
  const x2 = x * x;
  let power = x;
  let sum = x;
  for (let n = 1; n <= 14; n++) {
    power *= -x2;
    sum += power / (2 * n + 1);
  }
  return sum;
}

export function atan(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  return sign * (a > 1 ? HALF_PI - atanUnit(1 / a) : atanUnit(a));
}

export function atan2(y: number, x: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (x === 0 && y === 0) return 0;
  if (x === 0) return y > 0 ? HALF_PI : -HALF_PI;
  const a = atan(y / x);
  if (x > 0) return a;
  return y >= 0 ? a + PI : a - PI;
}

export function asin(x: number): number {
  if (Number.isNaN(x) || x > 1 || x < -1) return NaN;
  if (x === 1) return HALF_PI;
  if (x === -1) return -HALF_PI;
  return atan2(x, Math.sqrt(1 - x * x));
}

/** For tests: π/4, so callers can check the kernels' range. */
export const DMATH_REDUCED_RANGE = QUARTER_PI;
