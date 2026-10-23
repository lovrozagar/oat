/** Path-level parameters: the layout shape declares them once per path item, not per operation. */

import type { Json } from "./types.ts"

function hoistPathItem(item: Json): Json {
	const shared = new Map<string, Json>()
	const hoisted: Json = {}
	for (const [method, operation] of Object.entries(item)) {
		const parameters = ((operation as Json)["parameters"] ?? []) as Json[]
		for (const parameter of parameters) {
			if (parameter["in"] === "path") shared.set(String(parameter["name"]), parameter)
		}
		hoisted[method] = {
			...(operation as Json),
			parameters: parameters.filter((parameter) => parameter["in"] !== "path"),
		}
	}
	return shared.size === 0 ? item : { parameters: [...shared.values()], ...hoisted }
}

/** Moves each path item's `in: path` parameters from its operations onto the path item itself. */
export function hoistPathParameters(paths: Json): Json {
	const out: Json = {}
	for (const [route, item] of Object.entries(paths)) out[route] = hoistPathItem(item as Json)
	return out
}
