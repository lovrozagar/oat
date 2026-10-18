import { UNICODE_COHORT_STRING } from "../payloads.ts"
import type { Context, Variant } from "./types.ts"

const STRINGS: Readonly<Record<Variant, string>> = {
	baseline: "Quarterly Report",
	boundary: "",
	"lexical-first": "aaa first alphabetically",
	"lexical-last": "zzz last alphabetically",
	metacharacter: "100% _off_ *everything*",
	"null-heavy": "null heavy record",
	unicode: UNICODE_COHORT_STRING,
}

/** A variant's name as a URL- and address-safe token. */
export function slug(variant: Variant): string {
	return variant.replace(/[^a-z0-9]+/gi, "-").toLowerCase()
}

/** The variant's text with the cohort index, and the nonce when the value must be distinct. */
export function text(ctx: Context, distinct: boolean): string {
	const base = `${STRINGS[ctx.variant]} ${ctx.index}`
	return distinct && ctx.nonce !== undefined ? `${base} ${ctx.nonce}` : base
}
