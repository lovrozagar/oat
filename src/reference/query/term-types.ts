import type { FieldDef } from "../model/types.ts"
import type { Scalar } from "../query-types.ts"
import type { ParseContext } from "./conventions.ts"

/** One filter term, its operator already resolved: what a term builder reads. */
export interface TermInput {
	ctx: ParseContext
	field: FieldDef
	op: string
	raw: string
}

export interface TermRead extends TermInput {
	/** Compare the textual form of both sides: the numeric-as-text defect. */
	asText: boolean
	/** Text read as the field's type: a lenient backend answers `undefined`, a strict one throws. */
	typed: (text: string) => Scalar | undefined
}
