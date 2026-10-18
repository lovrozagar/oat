import { DefectSet } from "../defects/defect-set.ts"
import { fieldsWhere } from "../model/fields.ts"
import type { OrderTerm } from "../query-types.ts"
import { SqlError } from "../store-api.ts"
import type { ParseContext } from "./conventions.ts"
import { fieldOf, isNumeric, sortableFields } from "./fields.ts"
import { splitTopLevel } from "./split.ts"

const MODIFIERS: readonly string[] = ["asc", "desc", "nullsfirst", "nullslast"]

/* One order term's reading: the request's context, the defects that apply, the fields it may name. */
interface OrderRead {
	ctx: ParseContext
	defects: DefectSet
	sortable: string[]
}

/**
 * Parses a canonical order expression (`field.desc.nullslast,other`).
 *
 * `trusted` is for the server's own default order: it is not a request, so the request's
 * validation — and the defects that corrupt it — do not apply to it.
 */
export function parseOrder(expression: string, ctx: ParseContext, trusted = false): OrderTerm[] {
	const defects = trusted ? new DefectSet() : ctx.defects
	const sortable = trusted ? fieldsWhere(ctx.entity, "sortable") : sortableFields(ctx.entity, defects)
	const terms = splitTopLevel(expression).flatMap((term) => orderTerm(term, { ctx, defects, sortable }))
	return defects.has("SORT_MULTI_KEY_IGNORED") ? terms.slice(0, 1) : terms
}

function orderTerm(term: string, { ctx, defects, sortable }: OrderRead): OrderTerm[] {
	const { entity, conventions } = ctx
	const [name, ...parsed] = term.split(".") as [string, ...string[]]
	if (!sortable.includes(name)) {
		/* Correct is to reject; the defect drops a term naming a field that does not exist. */
		const exists = entity.fields.some((field) => field.name === name)
		if (defects.has("SORT_UNKNOWN_FIELD_IGNORED") && !exists) return []
		throw new SqlError("invalid_order", `field "${name}" is not sortable`)
	}
	const modifiers = readModifiers(parsed, defects)
	const descending = modifiers.includes("desc")
	/* The default placement is stated for ascending order; descending reverses it, so a
	 * descending sort is exactly the ascending one read backwards. */
	const defaultFirst = conventions.nulls === "first" ? !descending : descending
	const numeric = isNumeric(fieldOf(entity, name))
	return [
		{
			asText: numeric && (defects.has("SORT_NUMERIC_AS_TEXT") || defects.has("NUMERIC_COMPARED_AS_TEXT")),
			descending,
			field: name,
			nullsFirst: modifiers.includes("nullsfirst") ? true : modifiers.includes("nullslast") ? false : defaultFirst,
		},
	]
}

/* The modifiers after the field name, as the backend reads them. Throws on one it does not know. */
function readModifiers(parsed: string[], defects: DefectSet): string[] {
	/* The defect reads a direction it does not know as no direction at all: ascending. */
	const read = defects.has("IGNORES_BAD_SORT_DIRECTION")
		? parsed.filter((modifier) => MODIFIERS.includes(modifier))
		: parsed
	const modifiers = defects.has("SORT_NULLS_MODIFIER_IGNORED")
		? read.filter((modifier) => modifier !== "nullsfirst" && modifier !== "nullslast")
		: read
	for (const modifier of modifiers) {
		if (!MODIFIERS.includes(modifier)) throw new SqlError("invalid_order", `unknown sort modifier "${modifier}"`)
	}
	return modifiers
}
