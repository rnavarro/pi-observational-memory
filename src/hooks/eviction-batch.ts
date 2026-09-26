import type { Observation, Reflection } from "../session-ledger/index.js";
import type { DropDecision } from "../session-ledger/types.js";
import type { AdjudicationDecision } from "../agents/adjudicator/agent.js";

export type EvictionBatchPlan = {
	/** Ids that may actually be dropped, in dropper-proposed order. */
	droppedIds: string[];
	/** One committed decision per dropped id, in the same order. */
	decisions: DropDecision[];
	/** Reflections the caller must persist before the drops are committed. */
	distilled: Reflection[];
	/** Reflection ids that survive this batch (existing plus distilled). */
	survivingReflectionIds: string[];
	/** Observation id -> the reflection distilled from it. */
	distilledReflectionIdForObservation: Map<string, string>;
	keptIds: string[];
};

/**
 * Turn an adjudicated eviction batch into the exact set of drops the artifact
 * constructor will be asked to authorise.
 *
 * Only `retire`, `replace`, and `distill` verdicts commit. Anything else —
 * including a missing verdict — keeps the observation, so silence can never
 * authorise a drop.
 *
 * This planner is deliberately candidate-local: it can only commit drops the
 * dropper proposed and the adjudicator accepted. It does not reason about the
 * pool ceiling, because a planner restricted to the proposed batch cannot bound a
 * pool on its own — an empty or undersized proposal would leave the pool over its
 * ceiling with nothing to evict. Ceiling enforcement is a separate deterministic
 * stage that may evict observations the dropper never proposed, and it is the only
 * place allowed to do so.
 */
export function planEvictionBatch(args: {
	candidates: readonly Observation[];
	decisions: readonly AdjudicationDecision[];
	distilled: readonly Reflection[];
	currentReflectionIds: readonly string[];
}): EvictionBatchPlan {
	const indexById = new Map(args.candidates.map((candidate, index) => [candidate.id, index]));
	const decisionById = new Map<string, AdjudicationDecision>();
	for (const decision of args.decisions) {
		if (!decisionById.has(decision.id)) decisionById.set(decision.id, decision);
	}

	const dropped = args.candidates.filter((candidate) => {
		const decision = decisionById.get(candidate.id);
		return decision !== undefined && decision.outcome !== "keep";
	});
	const droppedIds = dropped.map((candidate) => candidate.id);
	const committedIds = new Set(droppedIds);

	// Computed before the decisions below, which persist each distillation's
	// witness id. `distilled` keeps only reflections that support a committed
	// observation, so a distilled reflection cannot witness a drop it does not
	// cover.
	const distilled = args.distilled.filter((reflection) =>
		reflection.supportingObservationIds.some((id) => committedIds.has(id)),
	);
	const distilledReflectionIdForObservation = new Map<string, string>();
	for (const reflection of distilled) {
		for (const observationId of reflection.supportingObservationIds) {
			if (committedIds.has(observationId)) distilledReflectionIdForObservation.set(observationId, reflection.id);
		}
	}

	const decisions: DropDecision[] = [];
	for (const observation of dropped) {
		const decision = decisionById.get(observation.id);
		if (!decision || decision.outcome === "keep") continue;
		if (decision.outcome === "replace") {
			decisions.push({
				id: observation.id,
				outcome: "replace",
				replacementReflectionId: decision.replacementReflectionId,
				...(decision.relation !== undefined ? { relation: decision.relation } : {}),
				rationale: decision.rationale,
			});
			continue;
		}
		if (decision.outcome === "distill") {
			// Persist the witness id on the decision itself, so the drop entry is
			// self-describing and an audit never has to infer the distillation
			// pairing from the reflections entry that precedes it.
			decisions.push({
				id: observation.id,
				outcome: "distill",
				distilledReflectionId: distilledReflectionIdForObservation.get(observation.id),
				rationale: decision.rationale,
			});
			continue;
		}
		decisions.push({
			id: observation.id,
			outcome: decision.outcome,
			supersededById: decision.supersededById,
			...(decision.relation !== undefined ? { relation: decision.relation } : {}),
			rationale: decision.rationale,
		});
	}

	const keptIds = args.candidates
		.filter((candidate) => !committedIds.has(candidate.id))
		.map((candidate) => candidate.id)
		.sort((a, b) => (indexById.get(a) ?? 0) - (indexById.get(b) ?? 0));

	return {
		droppedIds,
		decisions,
		distilled,
		survivingReflectionIds: [...args.currentReflectionIds, ...distilled.map((reflection) => reflection.id)],
		distilledReflectionIdForObservation,
		keptIds,
	};
}