/** The `x-query` declaration on a listing: what may be filtered, sorted, searched and selected. */

import type { Dialect } from "../dialect/types.ts"
import type { EntityDef, FieldDef } from "../model/types.ts"
import { fieldsWhere } from "../model/fields.ts"
import { renderOrder } from "./params.ts"
import type { Json, SpecContext } from "./types.ts"

type FilterCatalog = NonNullable<EntityDef["filterCatalog"]>

function queryFieldType(field: FieldDef | undefined): "string" | "number" | "boolean" | "enum" | undefined {
	if (field === undefined) return undefined
	if (field.enum !== undefined) return "enum"
	if (field.type === "integer" || field.type === "number") return "number"
	if (field.type === "boolean") return "boolean"
	if (field.type === "string") return "string"
	return undefined
}

function filterable(entity: EntityDef, catalog: FilterCatalog | undefined): unknown[] {
	if (catalog?.opsByField === undefined) return fieldsWhere(entity, "filterable")
	return Object.entries(catalog.opsByField).map(([field, ops]) => {
		const def = entity.fields.find((item) => item.name === field)
		const row: Json = { field, ops: [...ops] }
		const type = queryFieldType(def)
		if (type !== undefined) row["type"] = type
		return row
	})
}

function sortable(entity: EntityDef, catalog: FilterCatalog | undefined): unknown[] {
	if (catalog === undefined) return fieldsWhere(entity, "sortable")
	return fieldsWhere(entity, "sortable").map((field) => {
		const def = entity.fields.find((item) => item.name === field)
		const row: Json = { field }
		const type = queryFieldType(def)
		if (type !== undefined) row["type"] = type
		row["nulls"] = ["first", "last"]
		return row
	})
}

function nestedSelect(entity: EntityDef): Json {
	if (entity.relations === undefined) return {}
	return {
		select: {
			nested: true,
			relations: Object.entries(entity.relations).map(([name, relation]) => ({
				fields: [...relation.fields],
				name,
			})),
		},
	}
}

function catalogLimits(catalog: FilterCatalog | undefined): Json {
	if (catalog === undefined) return {}
	return {
		aliases: catalog.aliases ?? {},
		emptyIn: catalog.emptyIn,
		maxFilterConditions: catalog.maxFilterConditions,
		maxInValues: catalog.maxInValues,
		selectUnknown: catalog.selectUnknown,
		sortNulls: ["first", "last"],
		maxSortKeys: 3,
	}
}

export function queryDeclaration(ctx: SpecContext, entity: EntityDef, dialect: Dialect): Json {
	const catalog = entity.filterCatalog
	return {
		/* Declared rather than inferred: the grammar decides what oat can even express. */
		grammar: dialect.filterTemplate ?? dialect.grammar,
		...(dialect.sortTemplate === undefined ? {} : { sortGrammar: dialect.sortTemplate }),
		filterable: filterable(entity, catalog),
		/* Refused, as the listing does — unless the shape clamps silently, which it then says. */
		limitOutOfRange: ctx.shape.clampLimit === undefined ? "reject" : "clamp",
		maxLimit: entity.maxLimit,
		searchable: fieldsWhere(entity, "searchable"),
		selectable: entity.fields.map((f) => f.name),
		sortable: sortable(entity, catalog),
		stableTiebreak: entity.identity,
		/* Search semantics stated rather than left to inference: case-insensitive, and a blank
		 * term matches everything. */
		searchCase: "insensitive",
		searchEmpty: "match-all",
		sort: { defaultOrder: renderOrder(dialect, entity.defaultOrder) },
		...(dialect.params.searchMode === undefined ? {} : { searchModes: ["contains", "prefix"] }),
		...nestedSelect(entity),
		...catalogLimits(catalog),
	}
}
