import type { ParseContext } from "../query/conventions.ts"
import { SqlError } from "../store-api.ts"
import type { ListingOptions, ListingRequest } from "./types.ts"

/** The paging parameters, validated against the ranges the document publishes. */
export interface Paging {
	/** The page size served: the request's, the default, or a ceiling's. */
	servedLimit: number
	page: number | undefined
	offset: number | undefined
}

/** The integers a paging parameter may take: from `min`, up to `max` when there is one. */
export interface IntegerRange {
	min: number
	max?: number | undefined
}

export function integerParam(raw: string | undefined, name: string, { min, max }: IntegerRange): number | undefined {
	if (raw === undefined) return undefined
	const value = Number(raw)
	if (raw.trim() === "" || !Number.isInteger(value) || value < min || (max !== undefined && value > max)) {
		const range = max === undefined ? `>= ${min}` : `between ${min} and ${max}`
		throw new SqlError("invalid_paging", `query parameter "${name}" must be an integer ${range}`)
	}
	return value
}

/* LIMIT_OUT_OF_RANGE_SERVED: a page size outside the published range is quietly moved inside it. */
export function nearestLimit(raw: string | undefined, max: number | undefined): number | undefined {
	const value = integerParam(raw, "limit", { min: Number.MIN_SAFE_INTEGER })
	return value === undefined ? undefined : Math.min(Math.max(value, 1), max ?? value)
}

/** Reads the limit, then the page, then the offset; throws `SqlError` for the first out of range. */
export function pagingOf(
	ctx: Pick<ParseContext, "defects" | "entity">,
	request: ListingRequest,
	options: ListingOptions,
): Paging {
	const { defects, entity } = ctx
	const ceiling = defects.has("LIMIT_EXCEEDS_MAX") || options.clampLimit !== undefined ? undefined : entity.maxLimit
	const requestedLimit =
		(defects.has("LIMIT_OUT_OF_RANGE_SERVED")
			? nearestLimit(request.limit, ceiling)
			: integerParam(request.limit, "limit", { max: ceiling, min: 1 })) ?? entity.defaultLimit
	const servedLimit = defects.has("LIMIT_EXCEEDS_MAX")
		? requestedLimit
		: Math.min(requestedLimit, options.clampLimit ?? entity.maxLimit)
	const page = integerParam(request.page, "page", { min: 1 })
	const offset = integerParam(request.offset, "offset", { min: 0 })
	return { offset, page, servedLimit }
}
