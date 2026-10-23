/** The filter grammars oat recognises by name, written as the templates a document could declare. */

import type { FilterOp } from "../../config/types/query.ts"
import type { FilterGrammar } from "../conventions/types.ts"
import { FILTER_OPS } from "../query/ops.ts"
import type { FilterGrammarSpec } from "./filter-types.ts"

const COLON_OPS: readonly FilterOp[] = ["eq", "neq", "gt", "gte", "lt", "lte", "like"]

const identityOps = (ops: readonly FilterOp[]): Partial<Record<FilterOp, string>> =>
	Object.fromEntries(ops.map((op) => [op, op]))

/** The grammars oat recognises by name, as templates. */
export const FILTER_PRESETS: Readonly<Record<Exclude<FilterGrammar, "template">, FilterGrammarSpec>> = {
	colon: {
		and: { join: "," },
		escape: {},
		likeWildcard: "*",
		mixed: false,
		ops: /* @__PURE__ */ identityOps(COLON_OPS),
		or: "none",
		param: "filter",
		reserved: "",
		term: "{field}={op}:{value}",
	},
	equality: {
		and: "params",
		escape: {},
		likeWildcard: "*",
		mixed: false,
		ops: { eq: "eq" },
		or: "none",
		param: "field",
		reserved: "",
		term: "{value}",
	},
	/* A grammar nobody named: every operator is unwritable, so every filter check stands down. */
	unrecognised: {
		and: "repeat",
		escape: {},
		likeWildcard: "*",
		mixed: false,
		ops: {},
		or: "none",
		param: "filter",
		reserved: "",
		term: "{field}{op}{value}",
	},
	postgrest: {
		and: { group: "and({terms})", join: "," },
		escape: {},
		likeWildcard: "*",
		list: { close: ")", join: ",", open: "(" },
		mixed: true,
		null: { is: "{field}.is.null", not: "{field}.is.notnull" },
		ops: /* @__PURE__ */ identityOps(/* @__PURE__ */ FILTER_OPS.filter((op) => op !== "is")),
		or: { group: "or({terms})", join: "," },
		param: "filter",
		reserved: "",
		term: "{field}.{op}.{value}",
	},
}
