import {
	selectReflectionBudget,
	type ReflectionBudgetSelection,
} from "./reflection-budget.js";
import {
	OM_FOLDED,
	isMemoryDetails,
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	type Entry,
	type MemoryDetails,
	type Observation,
	type Reflection,
} from "./types.js";
import { estimateStringTokens } from "../tokens.js";

export type Projection = {
	observations: Observation[];
	reflections: Reflection[];
};

export type ProjectionDiff = {
	observationsOnlyInFull: Observation[];
	reflectionsOnlyInFull: Reflection[];
	droppedOnlyInFull: Observation[];
};

export type CompactionProjectionConfig = {
	observationsPoolMaxTokens: number;
	/**
	 * Token budget for reflections rendered in full. When set, the projection
	 * carries only the reflections that fit, and the remainder is returned as an
	 * index selection for the renderer. Omit to render every reflection, which is
	 * what the diagnostic views want.
	 */
	reflectionsBudgetTokens?: number;
	reflectionsIndexTokens?: number;
};

export type CompactionProjection = Projection & {
	fullFold: boolean;
	details: MemoryDetails;
	/** Present when a reflection budget was applied. */
	reflectionBudget?: ReflectionBudgetSelection;
};

type ProjectionBoundary =
	| { kind: "entry"; entryId: string }
	| { kind: "tip" }
	| { kind: "none" };

type ProjectionFoldOptions = {
	observationsBoundary: ProjectionBoundary;
	reflectionsBoundary: ProjectionBoundary;
	dropsBoundary: ProjectionBoundary;
};

function entryIndexById(entries: Entry[]): Map<string, number> {
	const indexes = new Map<string, number>();
	for (let i = 0; i < entries.length; i++) indexes.set(entries[i].id, i);
	return indexes;
}

function entryBoundary(entryId: string): ProjectionBoundary {
	return { kind: "entry", entryId };
}

function tipBoundary(): ProjectionBoundary {
	return { kind: "tip" };
}

function noneBoundary(): ProjectionBoundary {
	return { kind: "none" };
}

function boundaryIndex(entries: Entry[], indexes: Map<string, number>, boundary: ProjectionBoundary): number {
	if (boundary.kind === "tip") return entries.length - 1;
	if (boundary.kind === "none") return -1;
	return indexes.get(boundary.entryId) ?? -1;
}

function coverageIndex(entry: Entry & { data: { coversUpToId: string } }, indexes: Map<string, number>): number {
	return indexes.get(entry.data.coversUpToId) ?? -1;
}

function isAtOrBefore(index: number, boundaryIndex: number): boolean {
	return index >= 0 && boundaryIndex >= 0 && index <= boundaryIndex;
}

function isCoveredAtOrBefore(
	entry: Entry & { data: { coversUpToId: string } },
	indexes: Map<string, number>,
	boundaryIndex: number,
): boolean {
	return isAtOrBefore(coverageIndex(entry, indexes), boundaryIndex);
}

function foldProjection(entries: Entry[], options: ProjectionFoldOptions): Projection {
	const indexes = entryIndexById(entries);
	const observationsBoundary = boundaryIndex(entries, indexes, options.observationsBoundary);
	const reflectionsBoundary = boundaryIndex(entries, indexes, options.reflectionsBoundary);
	const dropsBoundary = boundaryIndex(entries, indexes, options.dropsBoundary);
	const observations: Observation[] = [];
	const reflections: Reflection[] = [];
	const observationsById = new Set<string>();
	const reflectionsById = new Set<string>();
	const droppedObservationIds = new Set<string>();

	for (const entry of entries) {
		if (isObservationsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, observationsBoundary)) {
			for (const observation of entry.data.observations) {
				if (observationsById.has(observation.id)) continue;
				observationsById.add(observation.id);
				observations.push(observation);
			}
			continue;
		}

		if (isReflectionsRecordedEntry(entry) && isCoveredAtOrBefore(entry, indexes, reflectionsBoundary)) {
			for (const reflection of entry.data.reflections) {
				if (reflectionsById.has(reflection.id)) continue;
				reflectionsById.add(reflection.id);
				reflections.push(reflection);
			}
			continue;
		}

		if (isObservationsDroppedEntry(entry) && isCoveredAtOrBefore(entry, indexes, dropsBoundary)) {
			for (const observationId of entry.data.observationIds) droppedObservationIds.add(observationId);
		}
	}

	return {
		observations: observations.filter((observation) => !droppedObservationIds.has(observation.id)),
		reflections,
	};
}

/**
 * Reflection ids named as a surviving representation by a committed drop.
 *
 * These are pinned into the full-text tier regardless of recency. A dropped
 * observation's only in-context trace is the reflection its decision named: if a
 * `replace` or `distill` witness ages into the index tier, the preservation
 * guarantee the adjudicator established silently degrades to a preview. Measured
 * over 1850 real folds, only 1.0% of 839 witnesses would otherwise fall outside a
 * 20000-token tier (0 of 266 distill witnesses), and pinning them costs about 199
 * tokens on the affected folds.
 *
 * Only ids are collected here, and the selector can only pin reflections that are
 * already eligible for the fold, so this cannot pull records across the fold
 * boundary.
 */
function dropWitnessReflectionIds(entries: Entry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of entries) {
		if (!isObservationsDroppedEntry(entry)) continue;
		for (const decision of entry.data.decisions ?? []) {
			if (decision.replacementReflectionId) ids.add(decision.replacementReflectionId);
			if (decision.distilledReflectionId) ids.add(decision.distilledReflectionId);
			if (decision.supersededById) ids.add(decision.supersededById);
		}
	}
	return ids;
}

function projectionFromMemoryDetails(details: MemoryDetails): Projection {
	return {
		observations: [...details.observations],
		reflections: [...details.reflections],
	};
}

/**
 * Rebuild a stored record list from the ids a fold persisted.
 *
 * The ids are stored instead of the records because the rendered text is already
 * in the fold summary, and a record's content is a function of its id
 * (`hashId(content)`), so the ids reproduce it exactly from the ledger entries
 * that authored it. Records sharing an id can differ only in metadata, so the
 * first record found for an id is safe to use.
 *
 * An id that does not resolve is marked explicitly rather than dropped. A shorter
 * list would read as "the model saw less memory than it did", which is the one
 * failure this storage change must not introduce.
 */
function resolveRecordIds<T extends { id: string }>(
	entries: Entry[],
	ids: readonly string[],
	recordsOf: (entry: Entry) => readonly T[] | undefined,
	unresolved: (id: string) => T,
): T[] {
	const wanted = new Set(ids);
	const resolved = new Map<string, T>();
	for (const entry of entries) {
		const records = recordsOf(entry);
		if (!records) continue;
		for (const record of records) {
			if (wanted.has(record.id) && !resolved.has(record.id)) resolved.set(record.id, record);
		}
	}
	return ids.map((id) => resolved.get(id) ?? unresolved(id));
}

function resolveReflectionIds(entries: Entry[], reflectionIds: readonly string[]): Reflection[] {
	return resolveRecordIds<Reflection>(
		entries,
		reflectionIds,
		(entry) => (isReflectionsRecordedEntry(entry) ? entry.data.reflections : undefined),
		(id) => {
			const content = `[unresolved reflection ${id}]`;
			return { id, content, supportingObservationIds: [], tokenCount: estimateStringTokens(content) };
		},
	);
}

function resolveObservationIds(entries: Entry[], observationIds: readonly string[]): Observation[] {
	return resolveRecordIds<Observation>(
		entries,
		observationIds,
		(entry) => (isObservationsRecordedEntry(entry) ? entry.data.observations : undefined),
		(id) => {
			const content = `[unresolved observation ${id}]`;
			return {
				id,
				content,
				timestamp: "(unresolved)",
				relevance: "low",
				sourceEntryIds: [],
				tokenCount: estimateStringTokens(content),
			};
		},
	);
}

function latestV3CompactionDetails(entries: Entry[]): MemoryDetails | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		if (!isMemoryDetails(entry.details)) continue;
		const details = entry.details;
		// Resolution lives here so every consumer inherits it, and because this is
		// the only place a stored fold snapshot is read back.
		if (details.observationIds === undefined && details.reflectionIds === undefined) return details;
		return {
			...details,
			...(details.observationIds !== undefined
				? { observations: resolveObservationIds(entries, details.observationIds) }
				: {}),
			...(details.reflectionIds !== undefined
				? { reflections: resolveReflectionIds(entries, details.reflectionIds) }
				: {}),
		};
	}
	return undefined;
}

export function latestMemoryDetails(entries: Entry[]): MemoryDetails | undefined {
	return latestV3CompactionDetails(entries);
}

export function fullProjection(entries: Entry[], upToEntryId?: string): Projection {
	const boundary = upToEntryId ? entryBoundary(upToEntryId) : tipBoundary();
	return foldProjection(entries, {
		observationsBoundary: boundary,
		reflectionsBoundary: boundary,
		dropsBoundary: boundary,
	});
}

export function visibleProjection(entries: Entry[], upToEntryId?: string): Projection {
	if (!upToEntryId) {
		const details = latestV3CompactionDetails(entries);
		return details ? projectionFromMemoryDetails(details) : { observations: [], reflections: [] };
	}

	return buildCompactionProjection(entries, upToEntryId, { observationsPoolMaxTokens: Number.POSITIVE_INFINITY });
}

export function latestFullFoldBoundaryId(entries: Entry[]): string | undefined {
	const indexes = entryIndexById(entries);
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type !== "compaction") continue;
		if (!isMemoryDetails(entry.details)) continue;
		if (!entry.details.fullFold) continue;
		if (!entry.firstKeptEntryId) continue;
		if (!indexes.has(entry.firstKeptEntryId)) continue;
		return entry.firstKeptEntryId;
	}
	return undefined;
}

export function buildCompactionProjection(
	entries: Entry[],
	firstKeptEntryId: string,
	config: CompactionProjectionConfig,
): CompactionProjection {
	const fullFoldBoundaryId = latestFullFoldBoundaryId(entries);
	const maintenanceBoundary = fullFoldBoundaryId ? entryBoundary(fullFoldBoundaryId) : noneBoundary();
	const normalProjection = foldProjection(entries, {
		observationsBoundary: entryBoundary(firstKeptEntryId),
		reflectionsBoundary: maintenanceBoundary,
		dropsBoundary: maintenanceBoundary,
	});
	const observationTokens = normalProjection.observations.reduce(
		(total, observation) => total + observation.tokenCount,
		0,
	);
	const fullFold = observationTokens >= config.observationsPoolMaxTokens;
	const projection = fullFold
		? fullProjection(entries, firstKeptEntryId)
		: normalProjection;

	// The fold summary replaces the model's context, so the reflection half of it
	// is bounded here rather than in the renderer: `details.reflections` is what
	// the model actually read, which keeps visibleProjection honest and lets the
	// index tier be derived as "everything else" instead of being persisted.
	const budgetTokens = config.reflectionsBudgetTokens;
	const indexBudgetTokens = config.reflectionsIndexTokens ?? 0;
	const reflectionBudget =
		typeof budgetTokens === "number" && Number.isFinite(budgetTokens) && budgetTokens > 0
			? selectReflectionBudget(projection.reflections, {
					budgetTokens,
					indexTokens: indexBudgetTokens,
					protectedIds: dropWitnessReflectionIds(entries),
				})
			: undefined;
	const reflections = reflectionBudget ? reflectionBudget.rendered : projection.reflections;

	const details: MemoryDetails = {
		type: OM_FOLDED,
		version: 1,
		fullFold,
		// Both arrays are empty by design: the rendered text is already in the summary
		// this fold returns, and each id rebuilds its content, so persisting the text
		// here stored the same records again on every fold.
		observations: [],
		observationIds: projection.observations.map((observation) => observation.id),
		reflections: [],
		reflectionIds: reflections.map((reflection) => reflection.id),
		...(reflectionBudget
			? {
					reflectionRender: {
						policyVersion: 1 as const,
						eligibleCount: projection.reflections.length,
						index: reflectionBudget.indexed,
						omittedCount: reflectionBudget.omittedCount,
						fullTokens: reflectionBudget.renderedTokens,
						indexTokens: reflectionBudget.indexedTokens,
						fullBudgetTokens: budgetTokens ?? 0,
						indexBudgetTokens,
					},
				}
			: {}),
	};

	return {
		fullFold,
		observations: projection.observations,
		reflections,
		details,
		...(reflectionBudget ? { reflectionBudget } : {}),
	};
}

export function diffProjection(visible: Projection, full: Projection): ProjectionDiff {
	const visibleObservationIds = new Set(visible.observations.map((observation) => observation.id));
	const fullObservationIds = new Set(full.observations.map((observation) => observation.id));
	const visibleReflectionIds = new Set(visible.reflections.map((reflection) => reflection.id));

	return {
		observationsOnlyInFull: full.observations.filter((observation) => !visibleObservationIds.has(observation.id)),
		reflectionsOnlyInFull: full.reflections.filter((reflection) => !visibleReflectionIds.has(reflection.id)),
		droppedOnlyInFull: visible.observations.filter((observation) => !fullObservationIds.has(observation.id)),
	};
}
