const PLOT_STEP = 25;
const MIN_BANDS = 4;
const MAX_BANDS = 5;
const NICE_STEPS = [1, 2, 5] as const;

/**
 * Project finite wire values onto a zero-based 1/2/5 decimal axis. Return
 * signed, bounded coordinates for gifted-charts; never feed it raw magnitudes.
 * Ticks retain finite numeric values in the original unit, while labels are
 * compact display-only approximations. Point details retain the wire values.
 */
export function chartValueAxis(values: readonly number[]) {
  let minimum = 0;
  let maximum = 0;
  let magnitude = 0;
  for (const value of values) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
    magnitude = Math.max(magnitude, Math.abs(value));
  }
  if (!magnitude) {
    return {
      values: values.map(() => 0), below: 0, above: MIN_BANDS,
      ticks: ['0', '1', '2', '3', '4'], labels: ['0', '1', '2', '3', '4'],
    };
  }

  // Comparing ratios avoids overflowing the range for opposite-sign MAX_VALUE.
  // Starting below the data's decade also works for subnormal numbers.
  const decade = Math.floor(Math.log10(magnitude));
  let step = magnitude;
  let below = 0;
  let above = 0;
  for (let exponent = decade - 3; exponent <= decade + 1; exponent++) {
    const power = 10 ** exponent;
    for (const factor of NICE_STEPS) {
      // 10^-324 underflows, but 5e-324 is representable.
      const candidate = power ? factor * power : exponent === -324 && factor === 5 ? Number.MIN_VALUE : 0;
      if (!Number.isFinite(candidate) || candidate <= 0) continue;
      const negativeBands = minimum < 0 ? Math.ceil(-minimum / candidate) : 0;
      const positiveBands = Math.ceil(maximum / candidate);
      if (negativeBands + positiveBands > MAX_BANDS || (maximum === 0 && negativeBands > MIN_BANDS)) continue;
      step = candidate;
      below = negativeBands;
      above = positiveBands;
      break;
    }
    if (below + above) break;
  }

  // Pad towards a representable new tick, never repeatedly cap an overflowing
  // multiple at MAX_VALUE. At the numeric limits fewer than four bands may fit.
  const tickValue = (index: number) => {
    const value = index * step;
    return Number.isFinite(value) ? value : Math.sign(index) * Number.MAX_VALUE;
  };
  while (below + above < MIN_BANDS) {
    const canExtendBelow = minimum < 0 && tickValue(-below - 1) < tickValue(-below);
    const canExtendAbove = maximum > 0 && tickValue(above + 1) > tickValue(above);
    if (!canExtendBelow && !canExtendAbove) break;
    const preferBelow = maximum === 0 || (minimum < 0 && -minimum > maximum && below <= above);
    if (canExtendBelow && (preferBelow || !canExtendAbove)) below++;
    else above++;
  }

  const ticks = Array.from({ length: below + above + 1 }, (_, index) => {
    const value = tickValue(index - below);
    return Math.abs(value) === Number.MAX_VALUE ? String(value) : String(Number(value.toPrecision(12)));
  });
  const labels = ticks.map((tick) => {
    const value = Number(tick);
    const rounded = Number(value.toPrecision(3));
    return (Number.isFinite(rounded) ? String(rounded) : value.toExponential(2).replace(/\.?0+e/, 'e'))
      .replace('e+', 'e');
  });
  const ratio = step / magnitude;
  return {
    values: values.map((value) => (value / magnitude) / ratio * PLOT_STEP),
    below, above, ticks, labels,
  };
}
