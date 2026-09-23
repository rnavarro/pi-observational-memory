/**
 * Measure whether content search reaches the reflections a fold budget omits.
 *
 * Replays real session ledgers from the pi session directory. At each fold it recomputes
 * the tiering with the shipped selector, takes the reflections that fit neither tier, and
 * asks two questions per sample:
 *
 *   self   - a query built from the record's own most distinctive terms. An upper bound:
 *            it shows the record is indexed and rankable, not that a real query finds it.
 *   cross  - a query built from the wording of the observation the reflection supports.
 *            A different phrasing of the same fact, which is the realistic case for a
 *            model that remembers the gist but not the sentence.
 *
 * It also records how deep an omitted record sits in a newest-first browse, so the
 * enumeration fallback can be judged, and how long a search takes on a real ledger.
 *
 * Usage: bun run scripts/measure-search-reach.ts [sessionDir] [maxSamples]
 * Results feed the "Discovery" section of docs/how-it-works.md; re-run it after changing
 * scoring, link expansion, or the budget defaults.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { searchMemory, type Entry } from "../src/session-ledger/search.js";
import { selectReflectionBudget } from "../src/session-ledger/reflection-budget.js";

const sessionRoot = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
const maxSamples = Number(process.argv[3] ?? 250);

/** Budgets under measurement; keep in step with the shipped defaults. */
const BUDGET_TOKENS = 20_000;
const INDEX_TOKENS = 5_000;
const SAMPLE_PER_FOLD = 3;
const RANK_PROBE = 25;

type RawEntry = {
	id: string;
	parentId?: string | null;
	timestamp?: string;
	customType?: string;
	data?: { observations?: unknown[]; reflections?: unknown[]; decisions?: unknown[]; coversUpToId?: string };
	details?: { type?: string };
};

type ReflectionRecord = { id: string; content: string; supportingObservationIds?: string[] };

function sessionFiles(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) sessionFiles(path, out);
		else if (name.endsWith(".jsonl")) out.push(path);
	}
	return out;
}

function normalize(entry: RawEntry): Entry {
	return {
		type: "custom",
		id: entry.id,
		parentId: entry.parentId ?? null,
		timestamp: entry.timestamp ?? "1970-01-01T00:00:00.000Z",
		customType: entry.customType,
		data: entry.data,
	} as Entry;
}

function distinctiveTerms(content: string, count: number): string[] {
	const tokens = content
		.toLowerCase()
		.split(/[^a-z0-9_./-]+/)
		.filter((token) => token.length >= 4 && !/^\d+$/.test(token));
	const picked: string[] = [];
	for (const token of tokens) {
		if (!picked.includes(token)) picked.push(token);
		if (picked.length >= count) break;
	}
	return picked;
}

function rankOf(entries: Entry[], query: string, targetId: string): number | undefined {
	const index = searchMemory(entries, query, { limit: RANK_PROBE }).hits.findIndex((hit) => hit.id === targetId);
	return index === -1 ? undefined : index + 1;
}

const quantile = (values: number[], q: number): number => {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))];
};

const folds: number[] = [];
const selfRanks: number[] = [];
const crossRanks: number[] = [];
const browseDepths: number[] = [];
const durations: number[] = [];
const ledgerSizes: number[] = [];
const sessionOmitted: number[] = [];
let sampled = 0;
let foldsWithOmissions = 0;
let crossReachedByLink = 0;

for (const file of sessionFiles(sessionRoot)) {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	if (!text.includes("om.folded")) continue;

	const reflections: ReflectionRecord[] = [];
	const observations = new Map<string, { content: string }>();
	const witness = new Set<string>();
	const entries: Entry[] = [];
	const omittedEver = new Set<string>();

	for (const line of text.split("\n")) {
		if (!line.includes("om.")) continue;
		let raw: RawEntry;
		try {
			raw = JSON.parse(line) as RawEntry;
		} catch {
			continue;
		}
		entries.push(normalize(raw));

		if (raw.customType === "om.reflections.recorded") {
			for (const record of (raw.data?.reflections ?? []) as ReflectionRecord[]) {
				if (!reflections.some((existing) => existing.id === record.id)) reflections.push(record);
			}
			continue;
		}
		if (raw.customType === "om.observations.recorded") {
			for (const record of (raw.data?.observations ?? []) as { id: string; content: string }[]) {
				if (!observations.has(record.id)) observations.set(record.id, record);
			}
			continue;
		}
		if (raw.customType === "om.observations.dropped") {
			for (const decision of (raw.data?.decisions ?? []) as Record<string, string>[]) {
				for (const key of ["replacementReflectionId", "distilledReflectionId", "supersededById"]) {
					if (decision[key]) witness.add(decision[key]);
				}
			}
			continue;
		}
		if (raw.details?.type !== "om.folded") continue;

		folds.push(1);
		if (reflections.length === 0) continue;
		ledgerSizes.push(reflections.length);

		const selection = selectReflectionBudget(reflections as never, {
			budgetTokens: BUDGET_TOKENS,
			indexTokens: INDEX_TOKENS,
			protectedIds: witness,
		});
		const rendered = new Set(selection.rendered.map((record) => record.id));
		const indexed = new Set(selection.indexed.map((record) => record.id));
		const omitted = reflections.filter((record) => !rendered.has(record.id) && !indexed.has(record.id));
		if (omitted.length === 0) continue;

		foldsWithOmissions++;
		for (const record of omitted) omittedEver.add(record.id);

		for (const target of omitted.slice(0, SAMPLE_PER_FOLD)) {
			if (sampled >= maxSamples) continue;
			sampled++;

			const sourceId = target.supportingObservationIds?.[0];
			const queries: Array<[string, string]> = [
				["self", distinctiveTerms(target.content, 3).join(" ")],
				["cross", distinctiveTerms(observations.get(sourceId ?? "")?.content ?? "", 4).join(" ")],
			];

			for (const [label, query] of queries) {
				if (!query) continue;
				const started = performance.now();
				const result = searchMemory(entries, query, { limit: RANK_PROBE });
				durations.push(performance.now() - started);

				const rank = result.hits.findIndex((hit) => hit.id === target.id);
				if (rank !== -1) (label === "self" ? selfRanks : crossRanks).push(rank + 1);
				if (label === "cross" && result.related.some((hit) => hit.id === target.id)) crossReachedByLink++;
			}

			browseDepths.push(reflections.length - reflections.findIndex((record) => record.id === target.id));
		}
	}

	if (omittedEver.size > 0) sessionOmitted.push(omittedEver.size);
}

const pct = (n: number, of: number): string => (of === 0 ? "n/a" : `${((n / of) * 100).toFixed(1)}%`);
const within = (ranks: number[], k: number): number => ranks.filter((rank) => rank <= k).length;

console.log(`folds scanned: ${folds.length}`);
console.log(`folds that omitted at least one reflection: ${foldsWithOmissions}`);
console.log(
	`unique reflections ever omitted: ${sessionOmitted.reduce((a, b) => a + b, 0)} across ${sessionOmitted.length} sessions (p50 ${quantile(sessionOmitted, 0.5)}, max ${Math.max(0, ...sessionOmitted)})`,
);
console.log(`ledger size at fold: p50 ${quantile(ledgerSizes, 0.5)}, p90 ${quantile(ledgerSizes, 0.9)}, max ${Math.max(0, ...ledgerSizes)}`);

console.log("\nSELF QUERY (the record's own terms; upper bound on indexability)");
for (const k of [1, 3, 10, RANK_PROBE]) console.log(`  top-${k}: ${within(selfRanks, k)}/${sampled} (${pct(within(selfRanks, k), sampled)})`);

console.log("\nCROSS QUERY (the supported observation's wording; a different phrasing)");
for (const k of [1, 3, 10, RANK_PROBE]) console.log(`  top-${k}: ${within(crossRanks, k)}/${sampled} (${pct(within(crossRanks, k), sampled)})`);
console.log(
	`  reached by a support link, not by terms: ${crossReachedByLink}/${sampled} (${pct(crossReachedByLink, sampled)})`,
);
console.log(
	`  combined first-page reach: ${within(crossRanks, 10) + crossReachedByLink}/${sampled} (${pct(within(crossRanks, 10) + crossReachedByLink, sampled)})`,
);

console.log(
	`\nBROWSE DEPTH of an omitted record (newest-first position): p50 ${quantile(browseDepths, 0.5)}, p90 ${quantile(browseDepths, 0.9)} (pages of 10: ${Math.ceil(quantile(browseDepths, 0.5) / 10)} / ${Math.ceil(quantile(browseDepths, 0.9) / 10)})`,
);
console.log(`SEARCH LATENCY: p50 ${quantile(durations, 0.5).toFixed(1)}ms, p90 ${quantile(durations, 0.9).toFixed(1)}ms`);