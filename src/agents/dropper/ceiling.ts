import { observationLineTokenCount } from "../../tokens.js";
import type { Observation } from "../../session-ledger/index.js";

/**
 * The v0.1 "operational hard limit" for the active observation pool.
 *
 * The dropper target (`observationsPoolTargetTokens`) is a soft maintenance
 * goal: it sizes how many drops the model is invited to propose. The ceiling is
 * the separate, non-negotiable bound on how much observation text may be
 * rendered into a fold summary. The adjudicator's `keep` verdicts are honoured
 * only while the pool stays under the ceiling; once it is exceeded, deterministic
 * ceiling enforcement evicts so that a pool of only-kept observations cannot grow
 * without bound.
 *
 * It is deliberately NOT `observationsPoolMaxTokens`: that knob is the
 * cache-policy trigger that decides when a fold rebuilds the prefix, and
 * reinterpreting it as a lossy-eviction threshold would change its meaning for
 * existing users.
 *
 * Shape is `min(fixedFloor, ratio x contextWindow)`, floored at the dropper
 * target. The ratio protects models with small windows (where a fixed 30k pool
 * could not fit); the fixed floor stops a very large advertised window from
 * producing an unbounded pool. When the result equals the target the ceiling
 * offers no headroom and keeps will be overridden under any target pressure,
 * which is the honest outcome for a window too small to hold more than the
 * target.
 */
export const DEFAULT_POOL_CEILING_TOKENS = 30_000;
export const DEFAULT_POOL_CEILING_RATIO = 0.25;

/**
 * Rationale recorded on every drop the deterministic ceiling authorises for an
 * observation the dropper never proposed, or that the adjudicator asked to keep.
 * Kept as a constant so log scans and tests can recognise policy-authorised loss.
 */
export const CEILING_OVERRIDE_RATIONALE = "active observation pool exceeded its ceiling; evicted by deterministic ceiling enforcement";

export function computeCeilingTokens(options: {
	contextWindow?: number;
	fixedTokens: number;
	ratio: number;
	targetTokens: number;
}): number {
	const targetTokens = Number.isFinite(options.targetTokens) && options.targetTokens > 0 ? options.targetTokens : 0;
	const fixedTokens = Number.isFinite(options.fixedTokens) && options.fixedTokens > 0 ? options.fixedTokens : DEFAULT_POOL_CEILING_TOKENS;
	const contextWindow = options.contextWindow;
	const ratio = options.ratio;

	let ceilingTokens = fixedTokens;
	if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0 && Number.isFinite(ratio) && ratio > 0) {
		ceilingTokens = Math.min(fixedTokens, Math.floor(contextWindow * ratio));
	}
	return Math.max(targetTokens, ceilingTokens);
}

export type PoolCeilingMetrics = {
	ceilingTokens: number;
	observationTokens: number;
	tokensOverCeiling: number;
	overCeiling: boolean;
};

export function observationTokens(observations: readonly Observation[]): number {
	return observations.reduce((sum, observation) => sum + observationLineTokenCount(observation), 0);
}

export function poolCeilingMetrics(observations: readonly Observation[], ceilingTokens: number): PoolCeilingMetrics {
	const tokens = observationTokens(observations);
	const tokensOverCeiling = Math.max(0, tokens - ceilingTokens);
	return {
		ceilingTokens,
		observationTokens: tokens,
		tokensOverCeiling,
		overCeiling: tokensOverCeiling > 0,
	};
}

const RELEVANCE_EVICTION_RANK: Record<Observation["relevance"], number> = {
	low: 0,
	medium: 1,
	high: 2,
	critical: 3,
};

function timestampRank(timestamp: string): number {
	const parsed = Date.parse(timestamp);
	return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Choose which observations to evict when the ceiling is exceeded, ignoring the
 * adjudicator's `keep` verdicts.
 *
 * Deterministic and independent of model output, so that a run of all-keeps
 * cycles still returns the pool to its bound: lowest relevance first, then
 * oldest first, taking only as many records as needed to free `tokensToFree`.
 * Critical and high observations are therefore evicted last, and the caller
 * logs the override so the loss is attributable rather than silent.
 */
export function selectCeilingEvictions(observations: readonly Observation[], tokensToFree: number): string[] {
	if (!Number.isFinite(tokensToFree) || tokensToFree <= 0) return [];

	const ordered = [...observations].sort((a, b) => {
		const relevanceDelta = RELEVANCE_EVICTION_RANK[a.relevance] - RELEVANCE_EVICTION_RANK[b.relevance];
		if (relevanceDelta !== 0) return relevanceDelta;
		return timestampRank(a.timestamp) - timestampRank(b.timestamp);
	});

	const selected: string[] = [];
	let freed = 0;
	for (const observation of ordered) {
		if (freed >= tokensToFree) break;
		selected.push(observation.id);
		freed += observationLineTokenCount(observation);
	}
	return selected;
}