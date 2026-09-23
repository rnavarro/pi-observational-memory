import { describe, expect, it } from "vitest";

import { ctxIsStale, isStaleCtxError } from "../src/stale-ctx.js";

const PI_STALE_MESSAGE =
	"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().";

describe("isStaleCtxError", () => {
	it("classifies Pi's exact stale-ctx message", () => {
		expect(isStaleCtxError(new Error(PI_STALE_MESSAGE))).toBe(true);
	});

	it("matches loosely, so incidental rewording stays classified", () => {
		expect(isStaleCtxError(new Error("error: extension ctx is stale (rewind)"))).toBe(true);
		expect(isStaleCtxError(new Error("EXTENSION CTX IS STALE"))).toBe(true);
	});

	it("classifies plain string errors", () => {
		expect(isStaleCtxError(PI_STALE_MESSAGE)).toBe(true);
	});

	it("rejects unrelated errors", () => {
		expect(isStaleCtxError(new Error("Connection error."))).toBe(false);
		expect(isStaleCtxError(new Error("429 admission queue queue-timeout"))).toBe(false);
		expect(isStaleCtxError(new Error("This extension ctx was refreshed"))).toBe(false);
	});

	it("rejects non-error values", () => {
		expect(isStaleCtxError(undefined)).toBe(false);
		expect(isStaleCtxError(null)).toBe(false);
		expect(isStaleCtxError({ message: PI_STALE_MESSAGE })).toBe(false);
	});
});

describe("ctxIsStale", () => {
	it("returns false when the ctx read succeeds", () => {
		expect(ctxIsStale({ sessionManager: { getBranch: () => [] } })).toBe(false);
	});

	it("returns true when the ctx read throws, regardless of wording", () => {
		expect(
			ctxIsStale({
				sessionManager: {
					getBranch: () => {
						throw new Error(PI_STALE_MESSAGE);
					},
				},
			}),
		).toBe(true);
		expect(
			ctxIsStale({
				sessionManager: {
					getBranch: () => {
						throw new Error("anything at all — the ctx is unusable");
					},
				},
			}),
		).toBe(true);
	});

	it("returns false when getBranch is absent (nothing knowable)", () => {
		expect(ctxIsStale({})).toBe(false);
		expect(ctxIsStale({ sessionManager: {} })).toBe(false);
	});
});
