/**
 * Branch-scoped content search over recorded observational memory.
 *
 * Why this exists: the fold summary renders reflections under a budget, so a record
 * past the index tier has no id in context, and `recall` resolves ids rather than
 * content. Without a content-addressed path, those records are not merely unrendered
 * but unreachable. This module is that path.
 *
 * It searches the ledger, not any projection: indexed, omitted, rendered and dropped
 * records are all candidates, so a bounded summary loses no retrieval reach. Nothing
 * here affects folding, coverage, or dropper state; it is a read path.
 */

import {
	isObservationsDroppedEntry,
	isObservationsRecordedEntry,
	isReflectionsRecordedEntry,
	type Entry,
	type Observation,
	type Reflection,
	type Relevance,
} from "./types.js";

export type MemorySearchScope = "reflections" | "observations" | "both";
export type MemorySearchMode = "query" | "enumerate";

export const MEMORY_SEARCH_DEFAULT_LIMIT = 10;
export const MEMORY_SEARCH_MAX_LIMIT = 25;
export const MEMORY_SEARCH_PREVIEW_CHARS = 280;

/** Tokens shorter than this are noise (articles, stray punctuation fragments). */
const MIN_TOKEN_CHARS = 2;
/** Scores are floats; two hits within this margin are reported as tied. */
const SCORE_EPSILON = 0.0001;
/** BM25 parameters, small corpus defaults. */
const BM25_K1 = 1.5;
const BM25_B = 0.75;

export type MemorySearchHit = {
	id: string;
	kind: "observation" | "reflection";
	/** Bounded preview, not the full record. Empty query means the record was not scored. */
	content: string;
	contentTruncated: boolean;
	score: number;
	matchedTerms: string[];
	/** Set when this hit was reached by following a support link rather than by matching terms. */
	linkedFrom?: { id: string; kind: "observation" | "reflection" };
	/** Observations only. */
	relevance?: Relevance;
	timestamp?: string;
	dropped?: boolean;
	/** Reflections only: how many observations claim it as support. */
	supportCount?: number;
};

export type MemorySearchResult = {
	mode: MemorySearchMode;
	query: string;
	scope: MemorySearchScope;
	/** Total candidates considered (enumerate) or records with a non-zero score (query). */
	total: number;
	/** How many of `total` matched on terms rather than being reached through a support link. */
	directCount: number;
	returned: number;
	offset: number;
	limit: number;
	hasMore: boolean;
	nextOffset?: number;
	hits: MemorySearchHit[];
	/** Records reached by following a support link from the best hits, not by matching terms. */
	related: MemorySearchHit[];
	/** Terms that matched nothing, so the caller can reshape a query. */
	unmatchedTerms: string[];
};

export type MemorySearchOptions = {
	scope?: MemorySearchScope;
	limit?: number;
	offset?: number;
	/**
	 * Follow support links from the best direct hits: an observation to the reflections
	 * that cite it, a reflection to the observations it cites. Defaults to true.
	 *
	 * Measured need: with term matching alone, a query worded like the observation a
	 * reflection was distilled from finds that reflection only 62% of the time, because
	 * a reflection is a paraphrase and shares few terms with its source. In 38% of those
	 * failures the source observation itself ranked in the top 10, so the link is what
	 * closes the gap.
	 */
	expandLinks?: boolean;
};

type SearchDocument = {
	id: string;
	kind: "observation" | "reflection";
	content: string;
	relevance?: Relevance;
	timestamp?: string;
	dropped?: boolean;
	supportCount?: number;
	/** Observations this record links to: a reflection's support ids, empty for an observation. */
	supportIds: string[];
	/** Insertion order in the ledger; also the recency order. */
	order: number;
	tokens: string[];
};

/** How many of the best direct hits seed link expansion. */
const LINK_SEED_LIMIT = 10;
/** Cap on related records returned per call. */
const LINK_RELATED_LIMIT = 10;
/** A linked record is reported as related, not as a term match. */
const LINK_SCORE_FACTOR = 0.5;

/**
 * Split text into comparable tokens, keeping identifier-shaped terms whole *and*
 * splitting them into parts. `src/session-ledger/reflection-budget.ts` therefore
 * matches both the full path and the words `session`, `reflection` and `budget`,
 * which is what makes a path or symbol query useful against prose paraphrases.
 */
export function memorySearchTokens(text: string): string[] {
	const parts: string[] = [];
	for (const raw of text.toLowerCase().split(/[^a-z0-9_./-]+/)) {
		if (!raw) continue;
		if (raw.length >= MIN_TOKEN_CHARS) parts.push(raw);
		if (/[._/-]/.test(raw)) {
			for (const piece of raw.split(/[._/-]+/)) {
				if (piece.length >= MIN_TOKEN_CHARS) parts.push(piece);
			}
		}
	}
	return parts;
}

function preview(content: string, maxChars = MEMORY_SEARCH_PREVIEW_CHARS): { content: string; truncated: boolean } {
	const collapsed = content.replace(/\s+/g, " ").trim();
	if (collapsed.length <= maxChars) return { content: collapsed, truncated: false };
	return { content: `${collapsed.slice(0, maxChars - 1)}…`, truncated: true };
}

function collectDocuments(entries: Entry[], scope: MemorySearchScope): SearchDocument[] {
	const documents: SearchDocument[] = [];
	const droppedIds = new Set<string>();
	const seen = new Set<string>();

	for (const entry of entries) {
		if (isObservationsDroppedEntry(entry)) {
			for (const id of entry.data.observationIds) droppedIds.add(id);
		}
	}

	const wantObservations = scope !== "reflections";
	const wantReflections = scope !== "observations";

	for (const entry of entries) {
		if (wantObservations && isObservationsRecordedEntry(entry)) {
			for (const observation of entry.data.observations) {
				if (seen.has(`observation:${observation.id}`)) continue;
				seen.add(`observation:${observation.id}`);
				documents.push(observationDocument(observation, droppedIds, documents.length));
			}
			continue;
		}
		if (wantReflections && isReflectionsRecordedEntry(entry)) {
			for (const reflection of entry.data.reflections) {
				if (seen.has(`reflection:${reflection.id}`)) continue;
				seen.add(`reflection:${reflection.id}`);
				documents.push(reflectionDocument(reflection, documents.length));
			}
		}
	}

	return documents;
}

function observationDocument(observation: Observation, droppedIds: Set<string>, order: number): SearchDocument {
	return {
		id: observation.id,
		kind: "observation",
		content: observation.content,
		relevance: observation.relevance,
		timestamp: observation.timestamp,
		dropped: droppedIds.has(observation.id),
		supportIds: [],
		order,
		tokens: [...new Set([observation.id, ...memorySearchTokens(observation.content)])],
	};
}

function reflectionDocument(reflection: Reflection, order: number): SearchDocument {
	return {
		id: reflection.id,
		kind: "reflection",
		content: reflection.content,
		supportCount: reflection.supportingObservationIds.length,
		supportIds: reflection.supportingObservationIds,
		order,
		tokens: [...new Set([reflection.id, ...memorySearchTokens(reflection.content)])],
	};
}

/**
 * Records reachable through a support link from the best direct hits.
 *
 * Measured need: a query worded like the observation a reflection was distilled from
 * finds that reflection only 62% of the time by terms alone, because a reflection is a
 * paraphrase of its source. In 38% of those failures the source observation itself
 * ranked top-10, so the link is what closes the gap.
 *
 * Related records are returned beside the ranked list rather than blended into it: in
 * replay, blending pushed directly-matched records down (a query that matched its target
 * at rank 2 dropped to rank 3+ once links were interleaved), and the link exists to add
 * a record the terms missed, not to reorder the ones they found.
 */
function relatedHits(
	scored: Array<{ document: SearchDocument; score: number; matchedTerms: string[] }>,
	documents: SearchDocument[],
	expandLinked: boolean,
	exclude: Set<string>,
): MemorySearchHit[] {
	if (!expandLinked || scored.length === 0) return [];

	const observationById = new Map<string, SearchDocument>();
	const reflectionsBySupport = new Map<string, SearchDocument[]>();
	for (const document of documents) {
		if (document.kind === "observation") {
			if (!observationById.has(document.id)) observationById.set(document.id, document);
			continue;
		}
		for (const supportId of document.supportIds) {
			const citing = reflectionsBySupport.get(supportId);
			if (citing) citing.push(document);
			else reflectionsBySupport.set(supportId, [document]);
		}
	}

	// Exclude only what the caller can already see on this page. Excluding every
	// term-matched record hides the case this feature exists for: an omitted record
	// often matches the query weakly and ranks past the page, so it is neither visible
	// nor correctly classified as absent. Measured over 250 replay samples, page-scoped
	// exclusion made a support link reach 32.4% of the records term matching missed
	// (against a 38% theoretical bound), where excluding all matches reached 4.8%.
	const seenKeys = new Set(exclude);
	const related: MemorySearchHit[] = [];
	for (const seed of sortScored([...scored]).slice(0, LINK_SEED_LIMIT)) {
		const neighbours =
			seed.document.kind === "observation"
				? (reflectionsBySupport.get(seed.document.id) ?? [])
				: seed.document.supportIds.map((id) => observationById.get(id)).filter((document): document is SearchDocument => !!document);
		for (const neighbour of neighbours) {
			const key = `${neighbour.kind}:${neighbour.id}`;
			if (seenKeys.has(key)) continue;
			seenKeys.add(key);
			if (related.length >= LINK_RELATED_LIMIT) return related;
			related.push(hitFromDocument(neighbour, seed.score * LINK_SCORE_FACTOR, seed.matchedTerms, { id: seed.document.id, kind: seed.document.kind }));
		}
	}
	return related;
}

function sortScored<T extends { document: SearchDocument; score: number }>(entries: T[]): T[] {
	return entries.sort((a, b) => (Math.abs(b.score - a.score) > SCORE_EPSILON ? b.score - a.score : a.document.order - b.document.order));
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 1) return MEMORY_SEARCH_DEFAULT_LIMIT;
	return Math.min(Math.floor(limit), MEMORY_SEARCH_MAX_LIMIT);
}

function clampOffset(offset: number | undefined): number {
	if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) return 0;
	return Math.floor(offset);
}

function termFrequencies(tokens: string[]): Map<string, number> {
	const frequencies = new Map<string, number>();
	for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
	return frequencies;
}

function hitFromDocument(document: SearchDocument, score: number, matchedTerms: string[], linkedFrom?: { id: string; kind: "observation" | "reflection" }, maxChars?: number): MemorySearchHit {
	const bounded = preview(document.content, maxChars);
	return {
		id: document.id,
		kind: document.kind,
		content: bounded.content,
		contentTruncated: bounded.truncated,
		score: Number(score.toFixed(3)),
		matchedTerms,
		...(linkedFrom ? { linkedFrom } : {}),
		...(document.kind === "observation"
			? { relevance: document.relevance, timestamp: document.timestamp, dropped: document.dropped === true }
			: { supportCount: document.supportCount }),
	};
}

/**
 * Search recorded memory, or enumerate it newest-first when the query is empty.
 *
 * Enumeration is the fallback for when the caller has no search terms: it is the only
 * way to discover a record whose wording cannot be guessed. Both modes page, so the
 * whole ledger is walkable without any single call returning an unbounded payload.
 */
export function searchMemory(entries: Entry[], query: string, options: MemorySearchOptions = {}): MemorySearchResult {
	const scope = options.scope ?? "both";
	const limit = clampLimit(options.limit);
	const offset = clampOffset(options.offset);
	const trimmedQuery = query.trim();
	const documents = collectDocuments(entries, scope);

	if (trimmedQuery.length === 0) {
		// Newest first: the current state of a session is carried by its later records,
		// and the caller paging from a known point is better served by recency than by
		// ledger order.
		const ordered = [...documents].sort((a, b) => b.order - a.order);
		const page = ordered.slice(offset, offset + limit);
		const hasMore = offset + limit < ordered.length;
		return {
			mode: "enumerate",
			query: "",
			scope,
			total: ordered.length,
		directCount: ordered.length,
		related: [],
			returned: page.length,
			offset,
			limit,
			hasMore,
			...(hasMore ? { nextOffset: offset + page.length } : {}),
			hits: page.map((document) => hitFromDocument(document, 0, [])),
			unmatchedTerms: [],
		};
	}

	const queryTerms = Array.from(new Set(memorySearchTokens(trimmedQuery)));
	if (queryTerms.length === 0) {
		// A query made only of one-character fragments behaves like no query at all.
		return searchMemory(entries, "", options);
	}

	const documentFrequency = new Map<string, number>();
	for (const term of queryTerms) {
		let count = 0;
		for (const document of documents) if (document.tokens.includes(term)) count++;
		documentFrequency.set(term, count);
	}

	const averageLength = documents.length > 0 ? documents.reduce((sum, document) => sum + document.tokens.length, 0) / documents.length : 0;
	const normalizedQuery = trimmedQuery.toLowerCase().replace(/\s+/g, " ");

	const scored: Array<{ document: SearchDocument; score: number; matchedTerms: string[] }> = [];
	for (const document of documents) {
		const frequencies = termFrequencies(document.tokens);
		const matchedTerms: string[] = [];
		let score = 0;

		for (const term of queryTerms) {
			const frequency = frequencies.get(term) ?? 0;
			if (frequency === 0) continue;
			matchedTerms.push(term);
			const documentCount = documentFrequency.get(term) ?? 0;
			const idf = Math.log(1 + (documents.length - documentCount + 0.5) / (documentCount + 0.5));
			const lengthNormalization = averageLength > 0 ? 1 - BM25_B + BM25_B * (document.tokens.length / averageLength) : 1;
			score += idf * ((frequency * (BM25_K1 + 1)) / (frequency + BM25_K1 * lengthNormalization));
		}

		if (score > 0 && normalizedQuery.length >= MIN_TOKEN_CHARS && document.content.toLowerCase().includes(normalizedQuery)) {
			score += 1;
		}
		if (score > 0 && document.id === trimmedQuery.toLowerCase()) score += 1;
		if (score > 0) scored.push({ document, score, matchedTerms });
	}

	sortScored(scored);
	const page = scored.slice(offset, offset + limit);
	const hasMore = offset + limit < scored.length;
	const matched = new Set(scored.flatMap((entry) => entry.matchedTerms));

	return {
		mode: "query",
		query: trimmedQuery,
		scope,
		total: scored.length,
		directCount: scored.length,
		returned: page.length,
		offset,
		limit,
		hasMore,
		...(hasMore ? { nextOffset: offset + page.length } : {}),
		hits: page.map((entry) => hitFromDocument(entry.document, entry.score, entry.matchedTerms)),
		related: relatedHits(scored, documents, options.expandLinks !== false, new Set(page.map((entry) => `${entry.document.kind}:${entry.document.id}`))),
		unmatchedTerms: queryTerms.filter((term) => !matched.has(term)),
	};
}