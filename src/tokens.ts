import { estimateTokens as estimateMessageTokens } from "@earendil-works/pi-coding-agent";

export function estimateStringTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Estimate the rendered footprint of an observation line as it appears in
 * summaries / pool listings: "[id] YYYY-MM-DD HH:MM [relevance] content".
 * Pool budgets that only count bare content undercount every line's
 * metadata overhead (id + timestamp + relevance tags), so the configured
 * pool target was reached later than the rendered memory actually allowed.
 */
export function observationLineTokenCount(observation: {
	id: string;
	timestamp: string;
	relevance: string;
	content: string;
}): number {
	return estimateStringTokens(
		`[${observation.id}] ${observation.timestamp} [${observation.relevance}] ${observation.content}`,
	);
}

/**
 * Estimate the rendered footprint of a reflection line as it appears in
 * summaries: "[id] content". The reflection budget is what keeps the
 * reflection half of a fold summary bounded, so it has to measure the same
 * string the renderer emits, id prefix included.
 */
export function reflectionLineTokenCount(reflection: { id: string; content: string }): number {
	return estimateStringTokens(`[${reflection.id}] ${reflection.content}`);
}

/**
 * Estimate the rendered footprint of an indexed reflection line, which carries
 * only the id plus a short preview so the model can see the record exists and
 * pull the full text with recall.
 */
export function reflectionIndexLineTokenCount(reflection: { id: string; content: string }, previewChars: number): number {
	return estimateStringTokens(`[${reflection.id}] ${previewReflectionContent(reflection.content, previewChars)}`);
}

/** First `previewChars` characters of reflection content, collapsed to one line. */
export function previewReflectionContent(content: string, previewChars: number): string {
	const collapsed = content.replace(/\s+/g, " ").trim();
	if (previewChars <= 0 || collapsed.length <= previewChars) return collapsed;
	return `${collapsed.slice(0, previewChars).trimEnd()}...`;
}

export function estimateEntryTokens(entry: { type: string; message?: unknown; content?: unknown; summary?: unknown }): number {
	if (entry.type === "message" && entry.message) {
		return estimateMessageTokens(entry.message as Parameters<typeof estimateMessageTokens>[0]);
	}
	if (entry.type === "custom_message" && entry.content) {
		const content = entry.content;
		if (typeof content === "string") return estimateStringTokens(content);
		if (Array.isArray(content)) {
			let total = 0;
			for (const block of content) {
				if (block.type === "text" && block.text) total += estimateStringTokens(block.text);
			}
			return total;
		}
	}
	if (entry.type === "branch_summary" && typeof entry.summary === "string") {
		return estimateStringTokens(entry.summary);
	}
	return 0;
}

