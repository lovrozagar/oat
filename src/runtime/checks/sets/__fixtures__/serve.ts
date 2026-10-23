import type { RequestOptions } from "../../../../client/types.ts"
import type { Record_ } from "../../../world/records.ts"
import type { Answer, Responder } from "../../__fixtures__/harness.ts"

/*
 * Backends for whole-set reads: rows served by page number, by offset or by cursor, at most
 * `serves` a page whatever was asked, wrapped by `wrap` when the list has an envelope.
 */

export const rows = (count: number): Record_[] => Array.from({ length: count }, (_, i) => ({ id: `n${i + 1}` }))

const param = (options: Pick<RequestOptions, "query">, name: string): number | undefined => {
	const value = options.query?.[name]
	return value === undefined ? undefined : Number(value)
}

export interface Serving {
	/** Most rows a page holds, whatever the request asked for. */
	serves?: number
	/** The answer for one page's rows; `start` is where they begin in the whole set. */
	wrap?: (page: Record_[], start: number) => Answer
}

/** Rows served by `page` and `limit`, or by `offset` when the request has no page. */
export function served(all: Record_[], serving: Serving = {}): Responder {
	return (_method, _path, options) => {
		const asked = param(options, "limit") ?? 100
		const size = Math.min(asked, serving.serves ?? asked)
		const page = param(options, "page")
		const start = page === undefined ? (param(options, "offset") ?? 0) : (page - 1) * asked
		const slice = all.slice(start, start + size)
		return serving.wrap?.(slice, start) ?? { body: slice, status: 200 }
	}
}

/** Rows served two at a time by an opaque cursor, the next one under `next`. */
export function cursored(all: Record_[], last: unknown = undefined): Responder {
	return (_method, _path, options) => {
		const start = Number(options.query?.["cursor"] ?? 0)
		const items = all.slice(start, start + 2)
		const next = start + 2 < all.length ? String(start + 2) : last
		return { body: { items, next }, status: 200 }
	}
}
