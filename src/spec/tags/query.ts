/** `x-query`, as `docs/tags.md` documents it. */

import { isQueryParamRole, QUERY_PARAM_ROLES } from "../conventions/query-params.ts"
import { parseFilterGrammar } from "../render/filter-parse.ts"
import type { QueryTag } from "../query/tag.ts"
import { parseSortGrammar } from "../render/sort-parse.ts"
import {
	type Check,
	checkAxis,
	checkShape,
	type Fields,
	type FieldsOf,
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

/** A parameter name per role: `{ filter: "filter_by" }`. */
function params(value: unknown): string | null {
	if (!isObject(value)) return "must be an object of role names"
	for (const [role, name] of Object.entries(value)) {
		if (!isQueryParamRole(role)) {
			return `names an unknown role "${role}"; the roles are ${QUERY_PARAM_ROLES.join(", ")}`
		}
		if (text(name) !== null) return `"${role}" must be a parameter name`
	}
	return null
}

const SORT_BLOCK = {
	collation: (value) => oneOf(value, ["binary", "case-insensitive", "locale"]),
	defaultNulls: (value) => oneOf(value, ["first", "last"]),
	defaultOrder: text,
	maxKeys: integer,
	nulls: texts,
	stableTiebreak: text,
} satisfies FieldsOf<NonNullable<QueryTag["sort"]>>

const RELATION: Fields = { fields: texts, name: text }

function relations(value: unknown): string | null {
	if (!Array.isArray(value)) return "must be an array of { name, fields } rows"
	for (const row of value) {
		const problem = checkShape(row, RELATION, ["name", "fields"])
		if (problem !== null) return `has a row that ${problem}`
	}
	return null
}

const SELECT_BLOCK = {
	nested: flag,
	relations,
	unknown: (value) => oneOf(value, ["reject", "ignore"]),
} satisfies FieldsOf<NonNullable<QueryTag["select"]>>

const X_QUERY = {
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
	params,
	operatorsByType: (value) =>
		isObject(value) && Object.values(value).every((ops) => texts(ops) === null)
			? null
			: "must map type names to arrays of operators",
	searchable: (value) => checkAxis(value, FIELD_ROW),
	searchableFrom: harvest,
	searchCase: (value) => oneOf(value, ["sensitive", "insensitive"]),
	searchEmpty: (value) => oneOf(value, ["ignore", "match-all", "reject"]),
	searchModes: texts,
	selectable: (value) => checkAxis(value, FIELD_ROW),
	selectableFrom: harvest,
	select: (value) => checkShape(value, SELECT_BLOCK),
	selectNested: flag,
	selectUnknown: (value) => oneOf(value, ["reject", "ignore"]),
	sort: (value) => checkShape(value, SORT_BLOCK),
	sortable: (value) => checkAxis(value, SORTABLE_ROW),
	sortableFrom: harvest,
	sortCollation: (value) => oneOf(value, ["binary", "case-insensitive", "locale"]),
	sortDefaultNulls: (value) => oneOf(value, ["first", "last"]),
	sortNulls: texts,
	stableTiebreak: text,
} satisfies FieldsOf<QueryTag>

export const xQuery: Check = (value) => checkShape(value, X_QUERY)
