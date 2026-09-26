import { describe, expect, it } from "vitest";
import {
	buildObservationsDroppedData,
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