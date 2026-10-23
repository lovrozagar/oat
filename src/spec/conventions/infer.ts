/** Grammars read off what a parameter's examples and description demonstrate. */

import type { ParameterObject } from "../types.ts"
import { demonstrated } from "./roles.ts"
import type { FilterGrammar, SelectGrammar, SortGrammar } from "./types.ts"

/**
 * Infers the filter grammar from the parameter's declared examples, which is where APIs
 * describing a grammar almost always demonstrate it. Defaults to one-parameter-per-field
 * equality — the assumption that holds for the widest range of APIs, and the one whose checks
 * degrade most gracefully when wrong.
 */
export function inferGrammar(filter: ParameterObject | undefined): FilterGrammar {
	if (filter === undefined) return "equality"
	const text = demonstrated(filter)
	/* Named outright in the description is the strongest signal — documents that describe a
	 * grammar almost always name it before demonstrating it. */
	if (/postgrest/i.test(text)) return "postgrest"
	if (/\b[\w.]+\.(eq|neq|gt|gte|lt|lte|like|ilike|in|nin|is|contains)\b/.test(text)) return "postgrest"
	/* `field.op.value` written as a schema rather than an instance. */
	if (/\bfield\.op\.value\b/i.test(text)) return "postgrest"
	if (/\b[\w.]+=(eq|neq|gt|gte|lt|lte|like|in):/.test(text)) return "colon"
	return "equality"
}

/**
 * Infers the sort grammar from what the document demonstrates.
 *
 * Descriptions and examples are where an API shows its hand — `sort=-created_at` is unambiguous,
 * and so is `field:desc`. Defaults to the dotted form, which is the most common and, being an
 * unrecognised token rather than a wrong direction, fails loudly rather than silently sorting
 * backwards when wrong.
 */
export function inferSortGrammar(order: ParameterObject | undefined): SortGrammar {
	if (order === undefined) return "dotted"
	const text = demonstrated(order)
	if (/\b[\w.]+\.(asc|desc)\b/i.test(text)) return "dotted"
	if (/\b[\w.]+:(asc|desc)\b/i.test(text)) return "colon"
	if (/\b[\w.]+\s+(asc|desc)\b/i.test(text)) return "spaced"
	/* A leading minus is the JSON:API convention; the "-" must precede a field name, not merely
	 * appear in prose, so the match is anchored to a token boundary. */
	if (/(^|[\s,="'])-[a-z_][\w.]*/i.test(text)) return "prefixed"
	return "dotted"
}

/** Infers how a sparse fieldset is written. `fields[type]=` is JSON:API's and unmistakable. */
export function inferSelectGrammar(select: ParameterObject | undefined): SelectGrammar {
	if (select === undefined) return "csv"
	if (/\[[^\]]+\]$/.test(select.name)) return "bracketed"
	const description = typeof select.description === "string" ? select.description : ""
	return /fields\[[^\]]+\]/.test(description) ? "bracketed" : "csv"
}
