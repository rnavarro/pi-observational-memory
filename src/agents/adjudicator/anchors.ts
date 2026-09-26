/**
 * Structural-anchor survival check for distillation and replacement.
 *
 * This is a DIAGNOSTIC, deliberately non-blocking. Mechanical extraction cannot
 * establish semantic fidelity: an anchor that survives can still sit in a
 * sentence whose negation, scope, or obligation was dropped, and an anchor that
 * goes missing is often only a formatting change (a UUID re-hyphenated, a path
 * split across two words). It also says nothing at all about the sources that
 * carry no anchors. What it can do is make the omission rate observable, so that
 * a real loss rate can be measured before anyone considers enforcing a gate.
 *
 * Anchors are the concrete identifiers whose loss is most visible downstream:
 * paths, commit-ish hashes, versions, camelCase symbols, and SCREAMING_CASE
 * constants. A hex run must contain both a digit and an a-f letter, so ordinary
 * words spelled from a-f are not mistaken for hashes and a hyphenated date or
 * numeric range (2026-09-20, 1908-1960) is not mistaken for a commit.
 *
 * Matching is verbatim by default. `analyzeAnchorSurvival` reports a second,
 * narrower reading that allows for the reformattings which carry no loss, so the
 * share of reported omissions that are only reformatting can be measured rather
 * than guessed from how many anchors went missing at once.
 */
const ANCHOR_PATTERNS: readonly RegExp[] = [
	// path-like, any number of segments: src/a/b.go, ./rel/path.ts
	/(?:\b[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w{0,6}\b/g,
	// commit-ish hex or hyphenated UUID, requiring at least one digit and one a-f
	// letter so ordinary a-f words are not hashes and all-digit dates and numeric
	// ranges are not either
	/\b(?=[0-9a-f-]*\d)(?=[0-9a-f-]*[a-f])[0-9a-f][0-9a-f-]{6,39}\b/g,
	// semantic version
	/\b\d+\.\d+\.\d+\b/g,
	// camelCase / PascalCase symbol, including short ones such as hashId
	/\b[a-z][a-z0-9]*[A-Z][A-Za-z0-9]+\b/g,
	// SCREAMING_CASE constant
	/\b[A-Z][A-Z0-9]{2,}_[A-Z0-9_]{2,}\b/g,
];

/** Distinct structural anchors in `content`, in first-seen order. */
export function extractAnchors(content: string): string[] {
	const found = new Set<string>();
	for (const pattern of ANCHOR_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of content.matchAll(pattern)) found.add(match[0]);
	}
	return Array.from(found);
}

/**
 * Anchors present in `sourceContent` that do not appear verbatim in
 * `survivingContent`. Empty means every extracted anchor carried over.
 *
 * Callers bound their own log volume by sampling candidates, not by trimming an
 * individual result: a sampled case is only useful if it shows every anchor that
 * went missing.
 */
export function missingAnchors(sourceContent: string, survivingContent: string): string[] {
	return extractAnchors(sourceContent).filter((anchor) => !survivingContent.includes(anchor));
}

/** The class of anchor, which selects the reformattings it may legitimately undergo. */
type AnchorShape = "hex" | "path" | "other";

function anchorShape(anchor: string): AnchorShape {
	if (anchor.includes("/")) return "path";
	if (/^[0-9a-fA-F][0-9a-fA-F-]*$/.test(anchor) && /\d/.test(anchor) && /[a-fA-F]/.test(anchor)) return "hex";
	return "other";
}

/**
 * Whether an anchor reappears in the surviving text once the reformattings that
 * carry no loss are allowed for.
 *
 * Deliberately narrow, and deliberately per class. A hex run is compared case-
 * and hyphen-insensitively, which is what a re-hyphenated UUID or an upper-cased
 * commit needs. A path may reappear as its trailing two segments or as a long
 * enough basename, because a relative-to-absolute rewrite or a split across a
 * line break loses nothing. Every other class keeps verbatim matching: a renamed
 * symbol or a changed version is a real change, and collapsing whitespace across
 * the check would let unrelated text satisfy it.
 */
function survivesAfterNormalization(anchor: string, survivingContent: string, survivingHexish: string): boolean {
	switch (anchorShape(anchor)) {
		case "hex":
			return survivingHexish.includes(anchor.toLowerCase().replace(/-/g, ""));
		case "path": {
			const segments = anchor.split("/").filter(Boolean);
			const trailing = segments.slice(-2).join("/");
			if (trailing && survivingContent.includes(trailing)) return true;
			const basename = segments[segments.length - 1] ?? "";
			return basename.length >= 8 && survivingContent.includes(basename);
		}
		default:
			return false;
	}
}

export type AnchorSurvival = {
	/** Distinct anchors the source carried. Zero means the loss rate cannot speak to it. */
	extracted: string[];
	/** Anchors absent verbatim from the surviving text. */
	missing: string[];
	/**
	 * Of `missing`, the ones still absent once class-specific reformatting is
	 * allowed for. The gap between `missing` and this is the artifact rate: a
	 * reformatted identifier is not a lost fact, but only the second list is
	 * evidence about fidelity, and a missing anchor there is not proof of loss
	 * either.
	 */
	missingAfterNormalization: string[];
};

export function analyzeAnchorSurvival(sourceContent: string, survivingContent: string): AnchorSurvival {
	const extracted = extractAnchors(sourceContent);
	const missing = extracted.filter((anchor) => !survivingContent.includes(anchor));
	// Computed once per call rather than per anchor: it is a whole-haystack view,
	// and the hex class is the only reader.
	const survivingHexish = survivingContent.toLowerCase().replace(/-/g, "");
	return {
		extracted,
		missing,
		missingAfterNormalization: missing.filter((anchor) => !survivesAfterNormalization(anchor, survivingContent, survivingHexish)),
	};
}