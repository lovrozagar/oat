/** Parse contexts over the reference model, for the query tests. */

import { DefectSet } from "../../defects/defect-set.ts"
import type { DefectName } from "../../defects/table.ts"
import { TABLE } from "../../model/table.ts"
import type { EntityDef, FieldDef } from "../../model/types.ts"
import type { Scalar } from "../../query-types.ts"
import { DEFAULT_CONVENTIONS, type ParseContext, type QueryConventions } from "../conventions.ts"
import type { TermRead } from "../term-types.ts"

export function context(
	defects: readonly DefectName[] = [],
	conventions: Partial<QueryConventions> = {},
	entity: EntityDef = TABLE,
): ParseContext {
	return { conventions: { ...DEFAULT_CONVENTIONS, ...conventions }, defects: new DefectSet(defects), entity }
}

export function field(name: string, entity: EntityDef = TABLE): FieldDef {
	const found = entity.fields.find((candidate) => candidate.name === name)
	if (found === undefined) throw new Error(`no field ${name} on ${entity.name}`)
	return found
}

/** A term as a builder reads it: values typed as the text itself unless told otherwise. */
export function termRead(read: Partial<TermRead> & Pick<TermRead, "field" | "op" | "raw">): TermRead {
	return { asText: false, ctx: context(), typed: (text: string): Scalar | undefined => text, ...read }
}
