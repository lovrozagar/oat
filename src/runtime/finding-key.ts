/**
 * The identity of a finding across runs.
 *
 * Two runs that hit the same defect word its detail the same way except for what is particular to
 * the run: the ids the backend issued, the nonce oat salted its values with, timestamps, the port
 * the backend listened on. Those are replaced with placeholders, and the summary is left out — it
 * is prose that may be reworded — so a baseline matches the defect and a diff calls it persisting.
 */

import type { Finding } from "./finding.ts"

const RUN_SPECIFIC: ReadonlyArray<readonly [RegExp, string]> = [
	[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
	[/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>"],
	/* A run folder's stamp, `20261015T210304Z`. */
	[/\b\d{8}T\d{6}Z?\b/g, "<stamp>"],
	[/\bhttps?:\/\/[^/\s"'`)]+/g, "<origin>"],
	[/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, "<ulid>"],
	/* `tbl_8f3k2`: a prefix and a suffix holding a digit. `created_at` and `proj_alpha` stay. */
	[/\b[a-z][a-z0-9]{0,15}_(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,}\b/g, "<id>"],
	/* A nonce or hash: hex with both a digit and a letter, eight or more long. */
	[/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/g, "<hex>"],
	/* Epoch times and other counters too long to be a quantity a reader compares. */
	[/\b\d{10,}\b/g, "<n>"],
]

export function normalizeDetail(detail: string): string {
	let text = detail
	for (const [pattern, placeholder] of RUN_SPECIFIC) text = text.replace(pattern, placeholder)
	return text
}

export function findingKey(finding: Pick<Finding, "check" | "entity" | "detail" | "operations" | "origin">): string {
	const operations = [...(finding.operations ?? [])].sort().join(",")
	return [finding.origin ?? "", finding.check, finding.entity, operations, normalizeDetail(finding.detail)].join("|")
}
