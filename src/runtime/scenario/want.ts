/**
 * What a scenario step asserts, and whether a response shows it.
 */

import type { ScenarioAssert, ScenarioRequestStep } from "../../config/types/steps.ts"
import { interpolate } from "../auth.ts"
import { cookiesFromRecordedHeaders } from "../cookies/set-cookie.ts"
import { describeSaveAs, readSaveAs } from "../cookies/save-as.ts"
import type { Exchange } from "../exchange.ts"
import { readAll, readPath } from "../path.ts"

/** What an assert wants, with `{name}` already filled in its path and its value. */
export type Want = { from: string; mode: "atLeast" | "contains" | "equals" | "excludes" | "omits"; value: string }

export function expected(assert: ScenarioAssert, scope: Record<string, string>): Want {
	const from = String(interpolate(assert.from, scope))
	if (assert.equals !== undefined) return { from, mode: "equals", value: String(interpolate(assert.equals, scope)) }
	if (assert.contains !== undefined)
		return { from, mode: "contains", value: String(interpolate(assert.contains, scope)) }
	if (assert.excludes !== undefined)
		return { from, mode: "excludes", value: String(interpolate(assert.excludes, scope)) }
	if (assert.atLeast !== undefined) return { from, mode: "atLeast", value: String(assert.atLeast) }
	if (assert.omits !== undefined) return { from, mode: "omits", value: String(interpolate(assert.omits, scope)) }
	throw new Error(`oat: an assert on ${assert.from} needs equals, contains, excludes, omits or atLeast`)
}

/** The values at `from`: a JSON path into the body, or `header:Name` / `cookie:name` as saveAs reads them. */
function observed(exchange: Exchange, from: string): unknown[] {
	if (describeSaveAs(from).kind === "json") return readAll(exchange.responseBody, from)
	const value = readSaveAs(from, {
		body: exchange.responseBody,
		cookies: exchange.cookies ?? cookiesFromRecordedHeaders(exchange.responseHeaders),
		headers: exchange.responseHeaders,
		readJson: readPath,
	})
	return value === undefined ? [] : [value]
}

/** The first value at `path` that meets `want`, as text — what the evidence records. */
export function shownValue(exchange: Exchange, path: string, want: Want): string | undefined {
	const nodes = observed(exchange, path).map((node) => (typeof node === "string" ? node : JSON.stringify(node)))
	if (want.mode === "excludes") return nodes.includes(want.value) ? undefined : want.value
	if (want.mode === "omits") return nodes.some((text) => text.includes(want.value)) ? undefined : want.value
	if (want.mode === "atLeast") {
		const floor = Number(want.value)
		return nodes.find((text) => text.trim() !== "" && Number(text) >= floor)
	}
	return nodes.some((text) => (want.mode === "equals" ? text === want.value : text.includes(want.value)))
		? want.value
		: undefined
}

/** A step's asserts, one or a list, each with what it wants. */
export function wantsOf(
	step: ScenarioRequestStep,
	scope: Record<string, string>,
): Array<{ assert: ScenarioAssert; want: Want }> {
	if (step.assert === undefined) return []
	const asserts = Array.isArray(step.assert) ? step.assert : [step.assert]
	return asserts.map((assert) => ({ assert, want: expected(assert, scope) }))
}

export function holds(exchange: Exchange, path: string, want: Want): boolean {
	return shownValue(exchange, path, want) !== undefined
}
