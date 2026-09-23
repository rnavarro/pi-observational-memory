export const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
export const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
export const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
export const OM_FOLDED = "om.folded";

export const RELEVANCE_VALUES = ["low", "medium", "high", "critical"] as const;
export type Relevance = (typeof RELEVANCE_VALUES)[number];

export const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;

export type Entry = {
	type: string;
	id: string;
	timestamp?: string;
	message?: unknown;
	content?: unknown;
	customType?: string;
	summary?: unknown;
	fromId?: string;
	data?: unknown;
	details?: unknown;
	firstKeptEntryId?: string;
};

export type Observation = {
	id: string;
	content: string;
	timestamp: string;
	relevance: Relevance;
	sourceEntryIds: string[];
	tokenCount: number;
};

export type Reflection = {
	id: string;
	content: string;
	supportingObservationIds: string[];
	tokenCount: number;
};

export type ObservationsRecordedEntryData = {
	observations: Observation[];
	coversUpToId: string;
};

export type ReflectionsRecordedEntryData = {
	reflections: Reflection[];
	coversUpToId: string;
};

/**
 * Outcomes that permit an observation to leave active memory. `keep` is not a
 * committed outcome: a kept observation is simply absent from the drop entry,
 * so it cannot be represented here.
 */
export const DROP_DECISION_OUTCOMES = ["retire", "replace", "distill"] as const;
export type DropDecisionOutcome = (typeof DROP_DECISION_OUTCOMES)[number];

/**
 * Per-observation adjudication verdict recorded alongside the drop it
 * authorises. This is an audit artifact, not live enforcement state: it is
 * re-derived every consolidation cycle, so a stale entry never keeps an
 * observation alive (see `mergeReflections`/`foldLedger` for the same
 * re-derive-each-run design).
 *
 * - `retire`: the observation is judged safe to drop, with a rationale.
 * - `replace`: an existing reflection is named as the surviving representation.
 * - `distill`: the adjudicator produced a new reflection from this observation,
 *   which must be appended before the drop is committed.
 */
export type DropDecision = {
	id: string;
	outcome: DropDecisionOutcome;
	replacementReflectionId?: string;
	/**
	 * Persisted witness for a `distill`: the reflection id that carries this
	 * observation's meaning. Recorded rather than recomputed so the entry is
	 * self-describing, and so an audit never has to infer the pairing from the
	 * preceding reflections entry.
	 */
	distilledReflectionId?: string;
	/**
	 * Structured supersession evidence for a `retire`: the reflection that makes
	 * this record obsolete. This is an evidence pointer, NOT an equivalence
	 * claim. A successor can establish that a record is completed, contradicted,
	 * or superseded by newer state without preserving its meaning, which is why
	 * it does not authorise `replace`. Whether it resolves is checked at the
	 * write boundary; the prose rationale is never parsed for ids.
	 */
	supersededById?: string;
	rationale?: string;
};

export type ObservationsDroppedEntryData = {
	observationIds: string[];
	coversUpToId: string;
	decisions?: DropDecision[];
};

/**
 * What a fold rendered, recorded so the tiering can be inspected after the fact.
 *
 * Without it, `/om:view visible` would show only the full-text tier and report
 * nothing about the records that were previewed or dropped from the summary, and
 * the index the model actually saw could not be reproduced once the ledger grew.
 */
export type ReflectionRenderDetails = {
	policyVersion: 1;
	/** Reflections eligible for rendering, before the budget was applied. */
	eligibleCount: number;
	/** Index tier: the id and the exact preview the model saw. */
	index: { id: string; preview: string }[];
	/** Eligible reflections that fit neither tier. */
	omittedCount: number;
	fullTokens: number;
	indexTokens: number;
	fullBudgetTokens: number;
	indexBudgetTokens: number;
};

export type MemoryDetails = {
	type: typeof OM_FOLDED;
	version: 1;
	fullFold: boolean;
	observations: Observation[];
	reflections: Reflection[];
	reflectionRender?: ReflectionRenderDetails;
};

export type V3MemoryCustomType =
	| typeof OM_OBSERVATIONS_RECORDED
	| typeof OM_REFLECTIONS_RECORDED
	| typeof OM_OBSERVATIONS_DROPPED;

export function isRelevance(value: unknown): value is Relevance {
	return typeof value === "string" && (RELEVANCE_VALUES as readonly string[]).includes(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isNonEmptyStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

export function isMemoryId(value: unknown): value is string {
	return typeof value === "string" && MEMORY_ID_PATTERN.test(value);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object";
}

export function isObservation(value: unknown): value is Observation {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		isNonEmptyString(value.timestamp) &&
		isRelevance(value.relevance) &&
		isNonEmptyStringArray(value.sourceEntryIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isReflection(value: unknown): value is Reflection {
	if (!isPlainRecord(value)) return false;
	return (
		isMemoryId(value.id) &&
		isNonEmptyString(value.content) &&
		!/\r|\n/.test(value.content) &&
		isNonEmptyStringArray(value.supportingObservationIds) &&
		isTokenCount(value.tokenCount)
	);
}

export function isObservationsRecordedData(value: unknown): value is ObservationsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.observations) &&
		value.observations.length > 0 &&
		value.observations.every(isObservation) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isReflectionsRecordedData(value: unknown): value is ReflectionsRecordedEntryData {
	if (!isPlainRecord(value)) return false;
	return (
		Array.isArray(value.reflections) &&
		value.reflections.length > 0 &&
		value.reflections.every(isReflection) &&
		isNonEmptyString(value.coversUpToId)
	);
}

export function isDropDecision(value: unknown): value is DropDecision {
	if (!isPlainRecord(value)) return false;
	if (!isMemoryId(value.id)) return false;
	if (typeof value.outcome !== "string" || !(DROP_DECISION_OUTCOMES as readonly string[]).includes(value.outcome)) return false;
	if (value.rationale !== undefined && typeof value.rationale !== "string") return false;
	if (value.replacementReflectionId !== undefined && !isMemoryId(value.replacementReflectionId)) return false;
	if (value.distilledReflectionId !== undefined && !isMemoryId(value.distilledReflectionId)) return false;
	if (value.supersededById !== undefined && !isMemoryId(value.supersededById)) return false;
	// Observation and reflection ids are both content hashes, so an observation
	// whose text exactly matches a persisted reflection legitimately shares that
	// reflection's id. Whether a replacement is real is therefore decided by
	// membership in the surviving reflection set at the artifact constructor, not
	// by comparing id strings here.
	if (value.outcome === "replace" && value.replacementReflectionId === undefined) return false;
	return true;
}

/**
 * Legacy drops carry only ids; `decisions` is optional and validated only when
 * present, so historical entries keep parsing (and replaying) unchanged.
 */
export function isObservationsDroppedData(value: unknown): value is ObservationsDroppedEntryData {
	if (!isPlainRecord(value)) return false;
	if (!isNonEmptyStringArray(value.observationIds) || !isNonEmptyString(value.coversUpToId)) return false;
	if (value.decisions === undefined) return true;
	return Array.isArray(value.decisions) && value.decisions.every(isDropDecision);
}

export function isMemoryDetails(value: unknown): value is MemoryDetails {
	if (!isPlainRecord(value)) return false;
	return (
		value.type === OM_FOLDED &&
		value.version === 1 &&
		typeof value.fullFold === "boolean" &&
		Array.isArray(value.observations) &&
		value.observations.every(isObservation) &&
		Array.isArray(value.reflections) &&
		value.reflections.every(isReflection)
	);
}

/**
 * Validate the optional render metadata. Absent or malformed details are treated
 * as "no recorded tiering", which is the conservative reading for a fold written
 * before the budget existed: its reflections were all rendered in full.
 */
export function isReflectionRenderDetails(value: unknown): value is ReflectionRenderDetails {
	if (!isPlainRecord(value)) return false;
	const numbers = ["eligibleCount", "omittedCount", "fullTokens", "indexTokens", "fullBudgetTokens", "indexBudgetTokens"];
	for (const key of numbers) {
		const field = (value as Record<string, unknown>)[key];
		if (typeof field !== "number" || !Number.isFinite(field) || field < 0) return false;
	}
	if (value.policyVersion !== 1) return false;
	if (!Array.isArray(value.index)) return false;
	return value.index.every(
		(entry) => isPlainRecord(entry) && isMemoryId((entry as { id?: unknown }).id) && typeof (entry as { preview?: unknown }).preview === "string",
	);
}

export function isObservationsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_RECORDED;
	data: ObservationsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_RECORDED && isObservationsRecordedData(entry.data);
}

export function isReflectionsRecordedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_REFLECTIONS_RECORDED;
	data: ReflectionsRecordedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_REFLECTIONS_RECORDED && isReflectionsRecordedData(entry.data);
}

export function isObservationsDroppedEntry(entry: Entry): entry is Entry & {
	type: "custom";
	customType: typeof OM_OBSERVATIONS_DROPPED;
	data: ObservationsDroppedEntryData;
} {
	return entry.type === "custom" && entry.customType === OM_OBSERVATIONS_DROPPED && isObservationsDroppedData(entry.data);
}

export function buildObservationsRecordedData(
	observations: Observation[],
	coversUpToId: string,
): ObservationsRecordedEntryData | undefined {
	if (observations.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { observations, coversUpToId };
}

export function buildReflectionsRecordedData(
	reflections: Reflection[],
	coversUpToId: string,
): ReflectionsRecordedEntryData | undefined {
	if (reflections.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;
	return { reflections, coversUpToId };
}

export type BuildDroppedDataOptions = {
	/**
	 * Ids that must carry a committed decision or the whole entry is refused.
	 * Callers must apply `keep` verdicts by removing them from `observationIds`
	 * before calling, so a refusal here means a genuine contract violation
	 * (missing, malformed, or conflicting decisions) rather than a normal keep.
	 */
	requireDecisionsFor?: ReadonlySet<string>;
	/** Reflection ids that survive this batch; `replace` must reference one. */
	survivingReflectionIds?: ReadonlySet<string>;
	/**
	 * Observation id -> the reflection id distilled from it. A `distill` decision
	 * is only authorised when its observation appears here, so a distilled
	 * reflection that was never persisted cannot silently authorise the loss of
	 * the observation it was written to preserve.
	 */
	distilledReflectionIdForObservation?: ReadonlyMap<string, string>;
	decisions?: readonly DropDecision[];
};

/**
 * Parse-tolerant constructor for the only artifact that retires an observation.
 *
 * Every safeguard here is opt-in, because this function is also the reader's
 * validator path: historical entries may carry decisions without the fields a
 * live write is now required to supply, and they must keep parsing. New writes
 * must therefore go through `buildObservationsDroppedDataStrict`, which derives
 * its requirements from the drop list itself and cannot be called with the
 * safeguards omitted.
 */
export function buildObservationsDroppedData(
	observationIds: string[],
	coversUpToId: string,
	options: BuildDroppedDataOptions = {},
): ObservationsDroppedEntryData | undefined {
	if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;

	const dropped = new Set(observationIds);
	const byId = new Map<string, DropDecision>();
	for (const decision of options.decisions ?? []) {
		if (!isDropDecision(decision)) return undefined;
		if (!dropped.has(decision.id)) continue;
		if (byId.has(decision.id)) return undefined;
		byId.set(decision.id, decision);
	}

	const required = options.requireDecisionsFor;
	if (required && required.size > 0) {
		for (const id of observationIds) {
			if (!required.has(id)) continue;
			const decision = byId.get(id);
			if (!decision) return undefined;
			if (decision.outcome === "replace") {
				const replacementReflectionId = decision.replacementReflectionId;
				if (!replacementReflectionId) return undefined;
				if (options.survivingReflectionIds && !options.survivingReflectionIds.has(replacementReflectionId)) return undefined;
				continue;
			}
			if (decision.outcome === "distill") {
				const distilledReflectionId = options.distilledReflectionIdForObservation?.get(id);
				if (!distilledReflectionId) return undefined;
				if (options.survivingReflectionIds && !options.survivingReflectionIds.has(distilledReflectionId)) return undefined;
			}
		}
	}

	const decisions = Array.from(byId.values());
	return decisions.length > 0 ? { observationIds, coversUpToId, decisions } : { observationIds, coversUpToId };
}

/**
 * The two sanctioned writers of a new drop entry.
 *
 * Requirements are outcome- and writer-dependent on purpose. The ceiling path
 * retires only and has no reflections to point at, so demanding survivor and
 * witness maps from it would be meaningless ceremony; the adjudicated path is
 * the one that must prove every preservation claim it makes.
 */
export type StrictDropWrite =
	| {
			mode: "adjudicated";
			decisions: readonly DropDecision[];
			/** Reflection ids that survive this batch (prior + distilled). */
			survivingReflectionIds: ReadonlySet<string>;
			/** Observation id -> the reflection id distilled from it. */
			distilledReflectionIdForObservation: ReadonlyMap<string, string>;
		}
	| {
			mode: "ceiling";
			decisions: readonly DropDecision[];
		};

/**
 * The enforcement choke point for new writes. Unlike the permissive constructor
 * above, this one derives its requirements from `observationIds` rather than
 * from a caller-supplied subset, so a write cannot weaken the contract by
 * forgetting to pass an argument. It is fail-closed: any violation refuses the
 * whole entry and the observations stay in active memory.
 *
 * Contract, per committed id:
 * - exactly one decision;
 * - `retire` carries a non-empty rationale, because it has no other evidence;
 * - `replace` names a reflection that survives the batch;
 * - `retire` with a `supersededById` names a reflection that survives the batch
 *   (an evidence pointer that does not resolve cannot be checked, so the claim
 *   is refused rather than trusted);
 * - `distill` names the persisted witness reflection, and it must match the
 *   reflection actually written for that observation and survive the batch;
 * - the ceiling writer may only retire.
 */
export function buildObservationsDroppedDataStrict(
	observationIds: string[],
	coversUpToId: string,
	write: StrictDropWrite,
): ObservationsDroppedEntryData | undefined {
	if (observationIds.length === 0 || !isNonEmptyString(coversUpToId)) return undefined;

	const byId = new Map<string, DropDecision>();
	for (const decision of write.decisions) {
		if (!isDropDecision(decision)) return undefined;
		if (byId.has(decision.id)) return undefined;
		byId.set(decision.id, decision);
	}

	for (const id of observationIds) {
		const decision = byId.get(id);
		if (!decision) return undefined;

		if (decision.outcome === "retire") {
			// Retire is the only outcome with no structured evidence, so it is the
			// only one where the rationale *is* the evidence. Demanding one from
			// replace/distill too would refuse batches that have better evidence, and
			// a refused batch leaves the pool under pressure, which is what pushes it
			// toward capacity eviction later.
			if (!decision.rationale?.trim()) return undefined;
			const supersededById = decision.supersededById;
			if (supersededById === undefined) continue;
			if (write.mode !== "adjudicated" || !write.survivingReflectionIds.has(supersededById)) return undefined;
			continue;
		}

		if (write.mode !== "adjudicated") return undefined;

		if (decision.outcome === "replace") {
			const replacementReflectionId = decision.replacementReflectionId;
			if (!replacementReflectionId || !write.survivingReflectionIds.has(replacementReflectionId)) return undefined;
			continue;
		}

		const witness = write.distilledReflectionIdForObservation.get(id);
		if (!witness || !write.survivingReflectionIds.has(witness)) return undefined;
		if (decision.distilledReflectionId !== undefined && decision.distilledReflectionId !== witness) return undefined;
	}

	return buildObservationsDroppedData(observationIds, coversUpToId, {
		requireDecisionsFor: new Set(observationIds),
		...(write.mode === "adjudicated"
			? {
					survivingReflectionIds: write.survivingReflectionIds,
					distilledReflectionIdForObservation: write.distilledReflectionIdForObservation,
				}
			: {}),
		decisions: write.decisions,
	});
}
