/** `x-query`, as `docs/tags.md` documents it. */

import { parseFilterGrammar } from "../render/filter-parse.ts"
import { parseSortGrammar } from "../render/sort-parse.ts"
import {
	type Check,
	checkAxis,
	checkShape,
	type Fields,
	flag,
	integer,
	isObject,
	oneOf,
	text,
	textMap,
	texts,
} from "./checks.ts"

const HARVEST: Fields = { operationId: text, path: text, typeMap: textMap, typePath: text }
const harvest: Check = (value) => checkShape(value, HARVEST, ["operationId", "path"])

const FIELD_ROW: Fields = { field: text }
const FILTERABLE_ROW: Fields = { field: text, ops: texts, type: text }
const SORTABLE_ROW: Fields = { field: text, nulls: texts, type: text }

function filterGrammar(value: unknown): string | null {
	if (!isObject(value)) return oneOf(value, ["postgrest", "colon", "equality"])
	const parsed = parseFilterGrammar(value)
	return parsed.ok ? null : `is a template oat cannot read: ${parsed.error}`
}

function sortGrammar(value: unknown): string | null {
	if (!isObject(value)) return oneOf(value, ["dotted", "prefixed", "colon", "spaced"])
	const parsed = parseSortGrammar(value)
	return parsed.ok ? null : `is a template oat cannot read: ${parsed.error}`
}

const X_QUERY: Fields = {
	aliases: textMap,
	defaultOrder: text,
	emptyIn: (value) => oneOf(value, ["reject", "match-none"]),
	limitOutOfRange: (value) => oneOf(value, ["reject", "clamp"]),
	filterable: (value) => checkAxis(value, FILTERABLE_ROW),
	filterableFrom: harvest,
	grammar: filterGrammar,
	identityFilter: text,
	sortGrammar,
	maxFilterConditions: integer,
	maxInValues: integer,
	maxLimit: integer,
	maxSortKeys: integer,
	operators: texts,
	operatorsByType: (value) =>
		isObject(value) && Object.values(value).every((ops) => texts(ops) === null)
			? null
			: "must map type names to arrays of operators",
	searchable: (value) => checkAxis(value, FIELD_ROW),
	searchableFrom: harvest,
	searchEmpty: (value) => oneOf(value, ["ignore", "match-all", "reject"]),
	searchModes: texts,
	selectable: (value) => checkAxis(value, FIELD_ROW),
	selectableFrom: harvest,
	selectNested: flag,
	selectUnknown: (value) => oneOf(value, ["reject", "ignore"]),
	sortable: (value) => checkAxis(value, SORTABLE_ROW),
	sortableFrom: harvest,
	sortCollation: (value) => oneOf(value, ["binary", "case-insensitive", "locale"]),
	sortDefaultNulls: (value) => oneOf(value, ["first", "last"]),
	sortNulls: texts,
	stableTiebreak: text,
}

export const xQuery: Check = (value) => checkShape(value, X_QUERY)
