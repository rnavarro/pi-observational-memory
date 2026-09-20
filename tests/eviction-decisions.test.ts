import { describe, expect, it } from "vitest";
import {
	buildObservationsDroppedData,
	buildObservationsDroppedDataStrict,
	isDropDecision,
	isObservationsDroppedData,
	type DropDecision,
} from "../src/session-ledger/types.js";

const A = "aaaaaaaaaaaa";
const B = "bbbbbbbbbbbb";
const C = "cccccccccccc";
const COVERS = "dddddddddddd";

function retire(id: string, rationale = "superseded"): DropDecision {
	return { id, outcome: "retire", rationale };
}

describe("isDropDecision", () => {
	it("accepts a retire decision", () => {
		expect(isDropDecision(retire(A))).toBe(true);
	});

	it("accepts replace naming a distinct reflection", () => {
		expect(isDropDecision({ id: A, outcome: "replace", replacementReflectionId: B })).toBe(true);
	});

	it("accepts distill", () => {
		expect(isDropDecision({ id: A, outcome: "distill" })).toBe(true);
	});

	it("rejects an unknown outcome", () => {
		expect(isDropDecision({ id: A, outcome: "keep" })).toBe(false);
		expect(isDropDecision({ id: A, outcome: "delete" })).toBe(false);
	});

	it("rejects a non-memory id", () => {
		expect(isDropDecision({ id: "not-an-id", outcome: "retire" })).toBe(false);
	});

	it("rejects replace without a named replacement", () => {
		expect(isDropDecision({ id: A, outcome: "replace" })).toBe(false);
	});

	it("accepts a replacement whose id matches the observation id", () => {
		// Observation and reflection ids are both content hashes, so an observation
		// already preserved verbatim as a reflection shares that reflection's id.
		// The constructor checks membership in the surviving reflection set instead.
		expect(isDropDecision({ id: A, outcome: "replace", replacementReflectionId: A })).toBe(true);
	});

	it("rejects a malformed replacement id", () => {
		expect(isDropDecision({ id: A, outcome: "replace", replacementReflectionId: "nope" })).toBe(false);
	});
});

describe("isObservationsDroppedData", () => {
	it("accepts a legacy entry with no decisions", () => {
		expect(isObservationsDroppedData({ observationIds: [A], coversUpToId: COVERS })).toBe(true);
	});

	it("accepts an entry carrying valid decisions", () => {
		expect(isObservationsDroppedData({ observationIds: [A], coversUpToId: COVERS, decisions: [retire(A)] })).toBe(true);
	});

	it("rejects an entry whose decisions are malformed", () => {
		expect(isObservationsDroppedData({ observationIds: [A], coversUpToId: COVERS, decisions: [{ id: A }] })).toBe(false);
		expect(isObservationsDroppedData({ observationIds: [A], coversUpToId: COVERS, decisions: "retire" })).toBe(false);
	});

	it("still requires a non-empty id list", () => {
		expect(isObservationsDroppedData({ observationIds: [], coversUpToId: COVERS })).toBe(false);
	});
});

describe("buildObservationsDroppedData without enforcement options", () => {
	it("behaves exactly as before for a plain drop", () => {
		expect(buildObservationsDroppedData([A, B], COVERS)).toEqual({ observationIds: [A, B], coversUpToId: COVERS });
	});

	it("refuses an empty id list", () => {
		expect(buildObservationsDroppedData([], COVERS)).toBeUndefined();
	});
});

describe("buildObservationsDroppedData enforcement", () => {
	const require = new Set([A, B]);

	it("refuses when a required id carries no decision", () => {
		expect(buildObservationsDroppedData([A, B], COVERS, { requireDecisionsFor: require, decisions: [retire(A)] })).toBeUndefined();
	});

	it("refuses when no decisions are supplied at all", () => {
		expect(buildObservationsDroppedData([A, B], COVERS, { requireDecisionsFor: require })).toBeUndefined();
	});

	it("builds when every required id is authorised", () => {
		const built = buildObservationsDroppedData([A, B], COVERS, {
			requireDecisionsFor: require,
			distilledReflectionIdForObservation: new Map([[B, C]]),
			decisions: [retire(A), { id: B, outcome: "distill" }],
		});
		expect(built?.observationIds).toEqual([A, B]);
		expect(built?.decisions).toHaveLength(2);
	});

	it("refuses conflicting duplicate decisions for one id", () => {
		expect(
			buildObservationsDroppedData([A], COVERS, {
				requireDecisionsFor: require,
				decisions: [retire(A), { id: A, outcome: "distill" }],
			}),
		).toBeUndefined();
	});

	it("refuses a malformed decision anywhere in the batch", () => {
		expect(
			buildObservationsDroppedData([A], COVERS, {
				requireDecisionsFor: require,
				decisions: [retire(A), { id: B, outcome: "bogus" } as unknown as DropDecision],
			}),
		).toBeUndefined();
	});

	it("refuses a replace whose replacement does not survive the batch", () => {
		const surviving = new Set([C]);
		expect(
			buildObservationsDroppedData([A], COVERS, {
				requireDecisionsFor: require,
				survivingReflectionIds: surviving,
				decisions: [{ id: A, outcome: "replace", replacementReflectionId: B }],
			}),
		).toBeUndefined();
	});

	it("accepts a replace whose replacement survives the batch", () => {
		const surviving = new Set([B]);
		const built = buildObservationsDroppedData([A], COVERS, {
			requireDecisionsFor: require,
			survivingReflectionIds: surviving,
			decisions: [{ id: A, outcome: "replace", replacementReflectionId: B }],
		});
		expect(built?.decisions?.[0].replacementReflectionId).toBe(B);
	});

	it("requires the colliding reflection to survive when the replacement id equals the observation id", () => {
		// Content-hashed namespaces: the replacement id equalling the observation id
		// is legitimate only while that reflection is actually in the survivor set.
		const surviving = new Set([A]);
		const decision: DropDecision = { id: A, outcome: "replace", replacementReflectionId: A };
		expect(
			buildObservationsDroppedData([A], COVERS, {
				requireDecisionsFor: require,
				survivingReflectionIds: surviving,
				decisions: [decision],
			}),
		).toBeDefined();
		expect(
			buildObservationsDroppedData([A], COVERS, {
				requireDecisionsFor: require,
				survivingReflectionIds: new Set([B]),
				decisions: [decision],
			}),
		).toBeUndefined();
	});

	it("refuses a distill whose reflection was never persisted", () => {
		expect(
			buildObservationsDroppedData([A], COVERS, {
				requireDecisionsFor: require,
				decisions: [{ id: A, outcome: "distill" }],
			}),
		).toBeUndefined();
	});

	it("refuses a distill whose reflection is claimed but not in the survivor set", () => {
		expect(
			buildObservationsDroppedData([A], COVERS, {
				requireDecisionsFor: require,
				survivingReflectionIds: new Set([C]),
				distilledReflectionIdForObservation: new Map([[A, B]]),
				decisions: [{ id: A, outcome: "distill" }],
			}),
		).toBeUndefined();
	});

	it("accepts a distill whose persisted reflection survives", () => {
		const built = buildObservationsDroppedData([A], COVERS, {
			requireDecisionsFor: require,
			survivingReflectionIds: new Set([B]),
			distilledReflectionIdForObservation: new Map([[A, B]]),
			decisions: [{ id: A, outcome: "distill" }],
		});
		expect(built?.decisions?.[0].outcome).toBe("distill");
	});

	it("does not record decisions for ids that are not being dropped", () => {
		const built = buildObservationsDroppedData([A], COVERS, {
			requireDecisionsFor: require,
			decisions: [retire(A), retire(B)],
		});
		expect(built?.decisions).toHaveLength(1);
		expect(built?.decisions?.[0].id).toBe(A);
	});

	it("leaves unprotected ids droppable without a decision", () => {
		const built = buildObservationsDroppedData([C], COVERS, {
			requireDecisionsFor: require,
			decisions: [retire(A), retire(B)],
		});
		expect(built).toEqual({ observationIds: [C], coversUpToId: COVERS });
	});
});
describe("buildObservationsDroppedDataStrict", () => {
	const adjudicated = (decisions: DropDecision[], overrides: Partial<{ surviving: string[]; witnesses: [string, string][] }> = {}) => ({
		mode: "adjudicated" as const,
		decisions,
		survivingReflectionIds: new Set(overrides.surviving ?? [B]),
		distilledReflectionIdForObservation: new Map(overrides.witnesses ?? []),
	});

	it("derives the requirement from the drop list, not from a caller subset", () => {
		// No options object at all: every dropped id still needs a decision.
		expect(buildObservationsDroppedDataStrict([A, B], COVERS, adjudicated([retire(A)]))).toBeUndefined();
	});

	it("refuses a retire with no rationale", () => {
		expect(buildObservationsDroppedDataStrict([A], COVERS, adjudicated([{ id: A, outcome: "retire" }]))).toBeUndefined();
	});

	it("refuses a retire with a blank rationale", () => {
		expect(buildObservationsDroppedDataStrict([A], COVERS, adjudicated([{ id: A, outcome: "retire", rationale: "   " }]))).toBeUndefined();
	});

	it("builds a plain retire with a rationale", () => {
		const built = buildObservationsDroppedDataStrict([A], COVERS, adjudicated([retire(A)]));
		expect(built?.decisions?.[0].outcome).toBe("retire");
	});

	it("refuses a replace whose reflection does not survive", () => {
		expect(
			buildObservationsDroppedDataStrict([A], COVERS, adjudicated([{ id: A, outcome: "replace", replacementReflectionId: C, rationale: "same" }])),
		).toBeUndefined();
	});

	it("builds a replace whose reflection survives", () => {
		const built = buildObservationsDroppedDataStrict(
			[A],
			COVERS,
			adjudicated([{ id: A, outcome: "replace", replacementReflectionId: B, rationale: "same" }]),
		);
		expect(built?.decisions?.[0].replacementReflectionId).toBe(B);
	});

	it("accepts a rationale-less replace, whose witness is its evidence", () => {
		// Scoped on purpose: only retire has nothing but the rationale to check.
		const built = buildObservationsDroppedDataStrict([A], COVERS, adjudicated([{ id: A, outcome: "replace", replacementReflectionId: B }]));
		expect(built?.decisions?.[0].replacementReflectionId).toBe(B);
	});

	it("refuses a supersession claim that names a non-surviving reflection", () => {
		expect(
			buildObservationsDroppedDataStrict([A], COVERS, adjudicated([{ id: A, outcome: "retire", supersededById: C, rationale: "obsolete" }])),
		).toBeUndefined();
	});

	it("builds a supersession claim that resolves in the surviving set", () => {
		const built = buildObservationsDroppedDataStrict(
			[A],
			COVERS,
			adjudicated([{ id: A, outcome: "retire", supersededById: B, rationale: "obsolete" }]),
		);
		expect(built?.decisions?.[0].supersededById).toBe(B);
	});

	it("refuses a distill with no persisted witness", () => {
		expect(buildObservationsDroppedDataStrict([A], COVERS, adjudicated([{ id: A, outcome: "distill", rationale: "durable" }]))).toBeUndefined();
	});

	it("refuses a distill whose witness does not survive", () => {
		expect(
			buildObservationsDroppedDataStrict([A], COVERS, adjudicated([{ id: A, outcome: "distill", rationale: "durable" }], { surviving: [B], witnesses: [[A, C]] })),
		).toBeUndefined();
	});

	it("refuses a distill whose recorded witness disagrees with the persisted reflection", () => {
		expect(
			buildObservationsDroppedDataStrict(
				[A],
				COVERS,
				adjudicated([{ id: A, outcome: "distill", distilledReflectionId: C, rationale: "durable" }], { surviving: [B, C], witnesses: [[A, B]] }),
			),
		).toBeUndefined();
	});

	it("builds a distill whose recorded witness matches the persisted reflection", () => {
		const built = buildObservationsDroppedDataStrict(
			[A],
			COVERS,
			adjudicated([{ id: A, outcome: "distill", distilledReflectionId: B, rationale: "durable" }], { witnesses: [[A, B]] }),
		);
		expect(built?.decisions?.[0].distilledReflectionId).toBe(B);
	});

	it("refuses duplicate decisions in a strict write", () => {
		expect(buildObservationsDroppedDataStrict([A], COVERS, adjudicated([retire(A), retire(A)]))).toBeUndefined();
	});

	it("ceiling mode accepts a plain retire and needs no reflection maps", () => {
		const built = buildObservationsDroppedDataStrict([A], COVERS, {
			mode: "ceiling",
			decisions: [{ id: A, outcome: "retire", rationale: "capacity" }],
		});
		expect(built?.decisions?.[0].outcome).toBe("retire");
	});

	it("ceiling mode still requires a rationale", () => {
		expect(buildObservationsDroppedDataStrict([A], COVERS, { mode: "ceiling", decisions: [{ id: A, outcome: "retire" }] })).toBeUndefined();
	});

	it("ceiling mode refuses a replace or distill, which it never produces", () => {
		expect(
			buildObservationsDroppedDataStrict([A], COVERS, { mode: "ceiling", decisions: [{ id: A, outcome: "replace", replacementReflectionId: B, rationale: "x" }] }),
		).toBeUndefined();
		expect(
			buildObservationsDroppedDataStrict([A], COVERS, { mode: "ceiling", decisions: [{ id: A, outcome: "distill", rationale: "x" }] }),
		).toBeUndefined();
	});

	it("ceiling mode refuses a supersession claim it cannot resolve", () => {
		expect(
			buildObservationsDroppedDataStrict([A], COVERS, { mode: "ceiling", decisions: [{ id: A, outcome: "retire", supersededById: B, rationale: "x" }] }),
		).toBeUndefined();
	});

	it("keeps the permissive reader accepting a legacy rationale-less entry", () => {
		// Replay parses history, so the strict contract must not leak into it.
		expect(isObservationsDroppedData({ observationIds: [A], coversUpToId: COVERS, decisions: [{ id: A, outcome: "retire" }] })).toBe(true);
	});
});
