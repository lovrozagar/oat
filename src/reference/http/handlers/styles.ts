/** The styles route: it parses a deepObject and a pipe-delimited query value on its own, as a server does. */

import { HttpError } from "../errors.ts"
import { respond } from "../wire.ts"
import type { Route } from "./fixed.ts"

const ID = /^[a-z0-9_]+$/

/* An integer written as `name[key]=<digits>`, or null. */
function bound(params: URLSearchParams, key: string): number | null {
	const text = params.get(`range[${key}]`)
	return text !== null && /^-?\d+$/.test(text) ? Number(text) : null
}

export const styles: Route = async (_state, request) => {
	if (request.method !== "GET" || request.url.pathname !== "/v1/styles") return undefined
	const params = request.url.searchParams
	const [min, max] = [bound(params, "min"), bound(params, "max")]
	const ids = params.getAll("ids")
	const parsed = ids.length === 1 ? (ids[0] as string).split("|") : []
	if (min === null || max === null || parsed.length === 0 || !parsed.every((id) => ID.test(id))) {
		throw new HttpError(
			400,
			"invalid_input",
			"range must be range[min] and range[max], and ids one pipe-delimited value",
		)
	}
	return respond(200, { ids: parsed, range: { max, min } })
}
