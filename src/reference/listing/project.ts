import type { DefectSet } from "../defects/defect-set.ts"
import type { EntityDef } from "../model/types.ts"
import type { Row } from "../store-api.ts"
import { NESTED, nestedFields, selectEntries, wholeRow } from "./select.ts"
import type { ListingOptions } from "./types.ts"

/** What a projection reads besides the row: the sparse fieldset, and how to load a relation. */
export interface Projection {
	select: string | undefined
	entity: EntityDef
	defects: DefectSet
	embed?: ListingOptions["embed"]
}

/** The row cut to its sparse fieldset, a nested entry embedding the related record's fields. */
export async function project(row: Row, { select, entity, defects, embed }: Projection): Promise<Row> {
	if (wholeRow(select)) return { ...row }
	if (defects.has("SELECT_IGNORED")) return { ...row }
	const out: Row = {}
	for (const entry of selectEntries(select as string)) {
		const nested = NESTED.exec(entry)
		if (nested !== null) {
			const name = nested[1] as string
			const related = embed === undefined ? null : await embed(name, row)
			if (related === null) {
				out[name] = null
				continue
			}
			/* The defect embeds the whole related record instead of the fields asked for. */
			out[name] = defects.has("NESTED_SELECT_IGNORED") ? related : picked(related, nested[2] as string)
			continue
		}
		if (!Object.hasOwn(row, entry)) continue
		if (defects.has("SELECT_FIELD_MISSING") && entry !== entity.identity) continue
		out[entry] = row[entry]
	}
	return out
}

/* The fields of `related` a nested entry lists, those it holds, in the order listed. */
function picked(related: Row, list: string): Row {
	return Object.fromEntries(
		nestedFields(list)
			.filter((field) => Object.hasOwn(related, field))
			.map((f) => [f, related[f]]),
	)
}
