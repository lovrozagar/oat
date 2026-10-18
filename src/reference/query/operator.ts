import type { EntityDef } from "../model/types.ts"
import { SqlError } from "../store-api.ts"
import type { ParseContext } from "./conventions.ts"

const OPERATORS: ReadonlySet<string> = /* @__PURE__ */ new Set([
	"eq",
	"ne",
	"neq",
	"gt",
	"gte",
	"lt",
	"lte",
	"in",
	"nin",
	"like",
	"ilike",
	"is",
	"contains",
])

/**
 * The operator a term's `rawOp` names on `name`, after the entity's alias table, or `null` when a
 * defect drops the term instead of refusing it. Throws for an operator a correct backend refuses.
 */
export function operatorFor(name: string, rawOp: string, ctx: ParseContext): string | null {
	const { defects, entity } = ctx
	if (!OPERATORS.has(rawOp)) {
		if (defects.has("FILTER_ILLEGAL_OP_IGNORED")) return null
		throw new SqlError("invalid_filter", `unknown operator "${rawOp}"`)
	}
	const op = aliased(rawOp, ctx)
	if (!allowedOn(entity, name, [rawOp, op])) {
		if (defects.has("FILTER_ILLEGAL_OP_IGNORED")) return null
		throw new SqlError("invalid_filter", `operator "${rawOp}" is not allowed on "${name}"`)
	}
	/* The document lists `like` on `slug`; under the overclaim the backend no longer supports it. */
	if (defects.has("SPEC_OVERCLAIMS_FILTER_OP") && name === "slug" && op === "like") {
		throw new SqlError("invalid_filter", `operator "like" is not supported on "slug"`)
	}
	return op
}

/* `rawOp` through the entity's alias table; `ne` is `neq` with or without one. */
function aliased(rawOp: string, { defects, entity }: ParseContext): string {
	const aliases = entity.filterCatalog?.aliases
	const alias = aliases !== undefined && Object.hasOwn(aliases, rawOp) ? aliases[rawOp] : undefined
	/* The alias table maps `ne` to the wrong operator. */
	const mapped = alias !== undefined && defects.has("FILTER_ALIAS_MISMAPPED") ? "eq" : alias
	return mapped ?? (rawOp === "ne" ? "neq" : rawOp)
}

/* Whether the field's operator allowlist, where it has one, names the operator in either spelling. */
function allowedOn(entity: EntityDef, name: string, [rawOp, op]: readonly [string, string]): boolean {
	const opsByField = entity.filterCatalog?.opsByField
	const allowed = opsByField !== undefined && Object.hasOwn(opsByField, name) ? opsByField[name] : undefined
	return allowed === undefined || allowed.includes(rawOp) || allowed.includes(op)
}
