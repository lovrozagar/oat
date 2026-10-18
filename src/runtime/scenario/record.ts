/**
 * What a passing request step keeps: its call, the values it saves into scope, the claims it reads
 * from a token, and the observation each of its asserts makes.
 */

import type { ScenarioAssert, ScenarioRequestStep } from "../../config/types/steps.ts"
import { interpolate, jwtClaims } from "../auth.ts"
import { cookiesFromRecordedHeaders, readSaveAs } from "../cookies.ts"
import type { Exchange } from "../exchange.ts"
import type { PassEvidence } from "../grades.ts"
import { readPath } from "../path.ts"
import { blamed, StepFailure } from "./failure.ts"
import type { ScenarioRun } from "./types.ts"
import { shownValue, type Want } from "./want.ts"

/** A request step that passed, and what it asserted. */
export interface Passed {
	step: ScenarioRequestStep
	exchange: Exchange
	stepOp: string | undefined
	wants: Array<{ assert: ScenarioAssert; want: Want }>
}

export function record(run: ScenarioRun, passed: Passed): void {
	const { stepOp } = passed
	/* An observed call keeps its pair; a later repeat of the operation proves nothing new. */
	if (stepOp !== undefined && !run.observations.has(stepOp)) run.calls.set(stepOp, passed.exchange)
	saveValues(run, passed)
	saveClaims(run, passed)
	if (passed.wants.length === 0) return
	observe(run, passed)
}

/** `saveAs`: each value into scope, an object, number or boolean also kept whole. */
function saveValues(run: ScenarioRun, passed: Passed): void {
	const { exchange, step, stepOp } = passed
	const { objects, scope } = run
	const cookies = exchange.cookies ?? cookiesFromRecordedHeaders(exchange.responseHeaders)
	for (const [name, template] of Object.entries(step.saveAs ?? {})) {
		const path = String(interpolate(template, scope))
		const value = readSaveAs(path, {
			body: exchange.responseBody,
			cookies,
			headers: exchange.responseHeaders,
			readJson: readPath,
		})
		if (value === undefined || value === null) {
			throw new StepFailure(`saveAs.${name} = "${path}" is not in the response`, [exchange], blamed(stepOp))
		}
		if (typeof value === "object") {
			objects.set(name, value)
			scope[name] = JSON.stringify(value)
		} else {
			if (typeof value === "number" || typeof value === "boolean") objects.set(name, value)
			else objects.delete(name)
			scope[name] = String(value)
		}
	}
}

/** `saveClaimsFrom`: claims of the JWT in scope or in the response, into scope. */
function saveClaims(run: ScenarioRun, passed: Passed): void {
	const { exchange, step, stepOp } = passed
	const { scope } = run
	if (step.saveClaimsFrom === undefined) return
	const from = step.saveClaimsFrom.token
	const token = !from.startsWith("$") && scope[from] !== undefined ? scope[from] : readPath(exchange.responseBody, from)
	const claims = typeof token === "string" ? jwtClaims(token) : null
	if (claims === null) {
		throw new StepFailure(`saveClaimsFrom: no JWT at ${from}`, [exchange], blamed(stepOp))
	}
	for (const [name, claim] of Object.entries(step.saveClaimsFrom.bind)) {
		const value = readPath(claims, claim)
		if (value === undefined || value === null) {
			throw new StepFailure(`saveClaimsFrom: the token carries no "${claim}"`, [exchange], blamed(stepOp))
		}
		scope[name] = String(value)
	}
}

/** Each assert observes the operations it names; the step's own operation is shown by its first assert. */
function observe(run: ScenarioRun, passed: Passed): void {
	const { exchange, stepOp, wants } = passed
	const { calls, observations } = run
	/* Every assert held on this exchange, so each shows a value. */
	const observationOf = (want: Want): PassEvidence["observation"] =>
		want.mode === "excludes" || want.mode === "omits"
			? { absent: true as const, path: want.from, seq: exchange.seq, value: want.value }
			: { path: want.from, seq: exchange.seq, value: shownValue(exchange, want.from, want) as string }
	/* A write's own response is its claim, not a later read of it: it proves nothing about itself. */
	const reads = /^(GET|HEAD)$/i.test(exchange.method)
	const prove = (id: string, want: Want): void => {
		if (!calls.has(id)) return
		if (calls.get(id) === exchange && !reads) return
		observations.set(id, observationOf(want))
	}
	for (const { assert, want } of wants) {
		for (const id of assert.observes ?? []) prove(id, want)
	}
	/* `record` observes only when the step asserts something. */
	const first = wants[0] as Passed["wants"][number]
	if (stepOp !== undefined) prove(stepOp, first.want)
}
