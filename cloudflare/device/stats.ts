// Run-to-run statistics for the device bench, and the baseline comparison
// that turns a slower run into a failure only beyond the noise between runs.

/** The middle value of `values`, which must not be empty. */
export function median(values: readonly number[]): number {
	return quantile(values, 0.5);
}

/** The 95th percentile of `values`, which must not be empty. */
export function p95(values: readonly number[]): number {
	return quantile(values, 0.95);
}

/** Linear-interpolated quantile `q` of `values`. */
export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) throw new Error("no samples");
	if (values.some((v) => !Number.isFinite(v))) throw new Error("a sample is not a finite number");
	const sorted = [...values].sort((a, b) => a - b);
	const at = (sorted.length - 1) * q;
	const low = Math.floor(at);
	const high = Math.ceil(at);
	return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
}

/** The median absolute deviation: how far a typical run sits from the median. */
export function spread(values: readonly number[]): number {
	const m = median(values);
	return median(values.map((v) => Math.abs(v - m)));
}

/** A metric's summary over repeated runs. */
export interface Summary {
	median: number;
	p95: number;
	spread: number;
	runs: number;
}

/** Summarize repeated samples of one metric. */
export function summarize(values: readonly number[]): Summary {
	return { median: median(values), p95: p95(values), spread: spread(values), runs: values.length };
}

/**
 * A metric that failed against its baseline: `slower` when its median grew by
 * more than the baseline allows, `noisy` when its runs scattered so widely that
 * the median can't be trusted and the bench must be rerun.
 */
export interface Regression {
	metric: string;
	kind: "slower" | "noisy";
	baseline: number;
	current: number;
	allowed: number;
}

/**
 * Compare each metric's median with the baseline's. The baseline alone sets
 * how far the median may grow: three times its spread, never less than `floor`
 * (in the metric's own unit), so a perfectly steady baseline does not fail on a
 * single millisecond. A noisy run gets no extra room, since that would let a
 * slower, scattered run pass; instead a run whose own spread exceeds three
 * times that tolerance's base fails as noisy.
 */
export function regressions(
	baseline: Record<string, Summary>,
	current: Record<string, Summary>,
	floor: Record<string, number>,
): Regression[] {
	const out: Regression[] = [];
	for (const [metric, base] of Object.entries(baseline)) {
		const now = current[metric];
		if (!now) throw new Error(`this run has no ${metric}, which the baseline has`);
		const steady = Math.max(base.spread, floor[metric] ?? 0);
		const allowed = Math.max(3 * base.spread, floor[metric] ?? 0);
		if (now.median - base.median > allowed)
			out.push({ metric, kind: "slower", baseline: base.median, current: now.median, allowed });
		else if (now.spread > 3 * steady)
			out.push({ metric, kind: "noisy", baseline: base.spread, current: now.spread, allowed: 3 * steady });
	}
	return out;
}
