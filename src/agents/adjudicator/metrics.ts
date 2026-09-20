/**
 * Adjudication observability.
 *
 * Every field here exists to answer one of the questions that decide whether the
 * eviction fix is working, and nothing is included that cannot be acted on:
 *
 * 1. Is the population the fix was built for actually protected? The dropper's
 *    old behaviour dropped every candidate blindly, and the population that hurt
 *    most was `high`/`critical` relevance at `none` coverage. `decisionsByTier`
 *    crosses relevance with coverage and outcome, so that question is answerable
 *    from the log instead of reconstructed from the ledger afterwards.
 * 2. Is a surviving representation dropping facts? `anchorReplace` and
 *    `anchorDistill` split the anchor diagnostic by the outcome that authored the
 *    surviving text. Distillation is written FROM the source, so a missing anchor
 *    there is a real omission; a replacement may legitimately cover a different,
 *    durable part of a multi-fact observation. Without the split, the two are
 *    indistinguishable and neither can be judged.
 * 3. Is a retirement evidenced rather than asserted? A `retire` carrying
 *    `supersededById` names checkable evidence; a bare `retire` stands on its
 *    rationale alone.
 * 4. Is the pool actually shrinking? `observationTokensByOutcome` says how many
 *    tokens each verdict removed from or left in the active pool, which is the
 *    only way to tell a preservation mechanism from a slow leak.
 * 5. Is the reflection pool growing without bound? `existingReflectionTokens`
 *    tracks the rendered reflection payload, which no ceiling bounds.
 * 6. What does the second model call cost? `durationMs`.
 *
 * Computed as a pure function so the payload can be tested directly rather than
 * scraped back out of the debug log.
 */
import type { Observation, Reflection } from "../../session-ledger/index.js";
import { coverageTierForObservation, type ReflectionCoverageTier } from "../dropper/coverage.js";

export type AdjudicationMetricOutcome = "keep" | "retire" | "replace" | "distill";

/** Minimal shape of a committed decision, so this module needs no agent import. */
export type MetricDecision = {
	id: string;
	outcome: AdjudicationMetricOutcome;
	supersededById?: string;
	rationale?: string;
};

/** Anchor-survival tally for one outcome that can author a surviving representation. */
export type AnchorSurvivalTally = { checked: number; clean: number; lossy: number; unanchored: number };

export type AnchorSurvivalTallies = Record<"replace" | "distill", AnchorSurvivalTally>;

export function createAnchorTallies(): AnchorSurvivalTallies {
	return {
		replace: { checked: 0, clean: 0, lossy: 0, unanchored: 0 },
		distill: { checked: 0, clean: 0, lossy: 0, unanchored: 0 },
	};
}

/**
 * One sampled anchor omission. Carries the observation id, the outcome that
 * authored the surviving text, the candidate's tier, and the missing anchors, so
 * a rate can be attributed without inferring which branch produced it.
 */
export type AnchorMissingSampleEntry = {
	observationId: string;
	outcome: "replace" | "distill";
	relevance: string;
	coverage: ReflectionCoverageTier;
	missing: string[];
};

/** Sampling cap, so a pathological batch cannot grow the log without bound. */
export const ANCHOR_SAMPLE_LIMIT = 12;

export type AdjudicationMetricsInput = {
	candidates: readonly Observation[];
	coverageById: ReadonlyMap<string, ReflectionCoverageTier>;
	decisions: readonly MetricDecision[];
	reflections: readonly Reflection[];
	distilledReflections: readonly Reflection[];
	anchorByOutcome: AnchorSurvivalTallies;
	anchorMissingSample: readonly AnchorMissingSampleEntry[];
	durationMs: number;
};

/** Sum of rendered reflection tokens, shared so both call sites agree. */
export function sumReflectionTokens(reflections: readonly Reflection[]): number {
	return reflections.reduce((total, reflection) => total + (reflection.tokenCount ?? 0), 0);
}

export type AdjudicationMetrics = {
	durationMs: number;
	anchorCheckedCount: number;
	anchorCleanCount: number;
	anchorLossyCount: number;
	anchorUnanchoredCount: number;
	anchorReplace: AnchorSurvivalTally;
	anchorDistill: AnchorSurvivalTally;
	anchorMissingSample: readonly AnchorMissingSampleEntry[];
	decisionsByTier: Record<string, Record<AdjudicationMetricOutcome, number>>;
	retireEvidencedCount: number;
	retireBareCount: number;
	retireWithoutRationaleCount: number;
	observationTokensByOutcome: Record<AdjudicationMetricOutcome, number>;
	existingReflectionCount: number;
	existingReflectionTokens: number;
	distilledReflectionTokens: number;
};

const emptyOutcomeCounts = (): Record<AdjudicationMetricOutcome, number> => ({ keep: 0, retire: 0, replace: 0, distill: 0 });

export function buildAdjudicationMetrics(input: AdjudicationMetricsInput): AdjudicationMetrics {
	const decisionsById = new Map(input.decisions.map((decision) => [decision.id, decision]));
	const decisionsByTier: Record<string, Record<AdjudicationMetricOutcome, number>> = {};
	const observationTokensByOutcome = emptyOutcomeCounts();
	let retireEvidencedCount = 0;
	let retireBareCount = 0;
	let retireWithoutRationaleCount = 0;

	for (const candidate of input.candidates) {
		const decision = decisionsById.get(candidate.id);
		if (!decision) continue;
		const tier = `${candidate.relevance}/${coverageTierForObservation(candidate, input.coverageById)}`;
		const bucket = decisionsByTier[tier] ?? emptyOutcomeCounts();
		bucket[decision.outcome] += 1;
		decisionsByTier[tier] = bucket;
		observationTokensByOutcome[decision.outcome] += candidate.tokenCount;
		if (decision.outcome !== "retire") continue;
		if (decision.supersededById) retireEvidencedCount++;
		else retireBareCount++;
		// Expected to stay zero: a retire without a rationale is refused by the
		// strict writer, so a non-zero value means the model stopped supplying one
		// and whole batches are being rejected rather than committed.
		if (!decision.rationale?.trim()) retireWithoutRationaleCount++;
	}

	let anchorCheckedCount = 0;
	let anchorCleanCount = 0;
	let anchorLossyCount = 0;
	let anchorUnanchoredCount = 0;
	const anchorTallies = [input.anchorByOutcome.replace, input.anchorByOutcome.distill];
	for (const tally of anchorTallies) {
		anchorCheckedCount += tally.checked;
		anchorCleanCount += tally.clean;
		anchorLossyCount += tally.lossy;
		anchorUnanchoredCount += tally.unanchored;
	}

	return {
		durationMs: input.durationMs,
		anchorCheckedCount,
		anchorCleanCount,
		anchorLossyCount,
		anchorUnanchoredCount,
		anchorReplace: input.anchorByOutcome.replace,
		anchorDistill: input.anchorByOutcome.distill,
		anchorMissingSample: input.anchorMissingSample,
		decisionsByTier,
		retireEvidencedCount,
		retireBareCount,
		retireWithoutRationaleCount,
		observationTokensByOutcome,
		existingReflectionCount: input.reflections.length,
		existingReflectionTokens: sumReflectionTokens(input.reflections),
		distilledReflectionTokens: sumReflectionTokens(input.distilledReflections),
	};
}