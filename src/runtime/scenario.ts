/**
 * Declared flows. The matrix reaches what the document lets it infer; a scenario is the config
 * saying how to reach the rest — a passkey ceremony, a paid checkout, an invite accepted by a
 * second user. oat runs the steps and grades what they observed. It never learns the product.
 */

import type {
	ExternalStep,
	Hooks,
	OutOfBandStep,
	Scenario,
	ScenarioAssert,
	ScenarioRequestStep,
	ScenarioStep,
} from "../config/define-config.ts"
import type { SpecModel } from "../spec/graph.ts"
import {
	type AcquireContext,
	interpolate,
	isBytes,
	jwtClaims,
	type OriginClient,
	resolveOutOfBandValue,
	resolveRequest,
	triggerSentAt,
} from "./auth.ts"
import type { Client, Exchange } from "./client.ts"
import { cookiesFromRecordedHeaders, describeSaveAs, readSaveAs } from "./cookies.ts"
import type { FindingCollector } from "./finding.ts"
import { readAll, readPath } from "./path.ts"
import type { BackoffConfig } from "./poll.ts"
import type { GradeLedger, PassEvidence } from "./scope.ts"

export function scenarioCheckId(scenario: Scenario): string {
	return `scenario.${scenario.id}`
}

function isExternal(step: ScenarioStep): step is ExternalStep {
	return "external" in step
}

function isOutOfBand(step: ScenarioStep): step is OutOfBandStep {
	return "outOfBand" in step
}

function stepOperation(step: ScenarioStep): string | undefined {
	return "operationId" in step && typeof step.operationId === "string" ? step.operationId : undefined
}

/** The secondary origin a step is sent to, or undefined for the main document. */
function stepOriginOf(step: ScenarioStep): string | undefined {
	return "origin" in step && typeof step.origin === "string" && step.origin !== "" ? step.origin : undefined
}

/**
 * Fails fast on a scenario that names what it cannot grade — before any request is sent. A step on
 * another origin names that origin's operation and is checked against its document; it supports
 * the scenario but never covers a main operation.
 */
export function assertScenarios(
	scenarios: readonly Scenario[],
	known: (operationId: string, origin?: string) => boolean,
): void {
	const seen = new Set<string>()
	for (const scenario of scenarios) {
		if (seen.has(scenario.id)) throw new Error(`oat: two scenarios share the id "${scenario.id}"`)
		seen.add(scenario.id)
		const called = new Set<string>()
		for (const step of scenario.steps) {
			const id = stepOperation(step)
			if (id === undefined) continue
			const origin = stepOriginOf(step)
			if (!known(id, origin)) {
				const where = origin === undefined ? "the document" : `the "${origin}" origin's document`
				throw new Error(`oat: scenario "${scenario.id}" calls ${id}, which is not in ${where}`)
			}
			if (origin === undefined) called.add(id)
		}
		for (const id of scenario.covers) {
			if (!called.has(id)) throw new Error(`oat: scenario "${scenario.id}" covers ${id} but no step calls it`)
		}
	}
}

/** `"30s"`, `"500ms"`, `"2m"`. */
function durationMs(text: string): number {
	const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(text.trim())
	if (match === null) throw new Error(`oat: "${text}" is not a duration (use 500ms, 30s or 2m)`)
	const value = Number(match[1])
	return match[2] === "ms" ? value : match[2] === "s" ? value * 1000 : value * 60_000
}

/** What an assert wants, with `{name}` already filled in its path and its value. */
type Want = { from: string; mode: "atLeast" | "contains" | "equals" | "excludes" | "omits"; value: string }

function expected(assert: ScenarioAssert, scope: Record<string, string>): Want {
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
function shownValue(exchange: Exchange, path: string, want: Want): string | undefined {
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

function holds(exchange: Exchange, path: string, want: Want): boolean {
	return shownValue(exchange, path, want) !== undefined
}

/** The wait before the next poll: doubling to five seconds, never shorter than the interval asked for. */
export function nextPollWait(current: number, everyMs: number): number {
	return Math.min(current * 2, Math.max(5_000, everyMs))
}

function succeeded(step: ScenarioRequestStep, exchange: Exchange): boolean {
	const accepted = step.expect ?? []
	if (accepted.length > 0) return accepted.includes(exchange.status)
	return exchange.status >= 200 && exchange.status < 300
}

class StepFailure extends Error {
	constructor(
		message: string,
		readonly evidence: Exchange[],
		readonly blames: string[],
	) {
		super(message)
	}
}

export async function runScenarios(input: {
	scenarios: readonly Scenario[]
	model: SpecModel
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	hooks: Hooks
	checksRun: Set<string>
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	principals: ReadonlyMap<string, { headers: () => Record<string, string>; roots: Record<string, string> }>
	defaultPrincipal: string
	outOfBand?: Partial<BackoffConfig>
	originClients?: ReadonlyMap<string, OriginClient>
	sleep?: (ms: number) => Promise<void>
}): Promise<void> {
	const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	for (const scenario of input.scenarios) {
		const graded = scenario.covers.filter((id) => input.mode === "full" || input.inScope(id))
		const touches = scenario.steps.some((step) => {
			const id = stepOperation(step)
			return id !== undefined && input.inScope(id)
		})
		if (graded.length === 0 && !touches) continue
		const check = scenarioCheckId(scenario)
		input.checksRun.add(check)
		const principalOf = (id: string) => {
			const found = input.principals.get(id)
			if (found === undefined)
				throw new Error(`oat: scenario "${scenario.id}" names principal "${id}", which is not configured`)
			return found
		}
		const own = principalOf(scenario.principal ?? input.defaultPrincipal)
		const headers = own.headers
		const context: AcquireContext = {
			client: input.client,
			hooks: input.hooks,
			model: input.model,
			principalId: scenario.principal ?? input.defaultPrincipal,
			...(input.originClients === undefined ? {} : { originClients: input.originClients }),
			...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
		}
		/* The principal's roots (organization, project …) are there from the first step, as in the matrix. */
		const scope: Record<string, string> = { ...own.roots }
		/* Values a response or a hook handed back, kept whole: a field that is exactly `{name}`
		 * sends the object itself (a WebAuthn credential), or the number or boolean with its type,
		 * not its string form. */
		const objects = new Map<string, unknown>()
		const withObjects = (value: unknown): unknown => {
			if (typeof value === "string") {
				const name = /^\{([A-Za-z0-9_]+)\}$/.exec(value)?.[1]
				return name !== undefined && objects.has(name) ? objects.get(name) : value
			}
			if (Array.isArray(value)) return value.map(withObjects)
			if (isBytes(value)) return value
			if (value !== null && typeof value === "object") {
				return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withObjects(item)]))
			}
			return value
		}
		const calls = new Map<string, Exchange>()
		/* What this scenario sent, so a value delivered outside HTTP finds the request it answers. */
		const sent: Exchange[] = []
		const observed = new Map<string, PassEvidence["observation"]>()
		let stoppedAt: { index: number; failure: StepFailure } | null = null

		for (const [index, step] of scenario.steps.entries()) {
			try {
				await runStep(step, index)
			} catch (error) {
				const failure =
					error instanceof StepFailure
						? error
						: new StepFailure(error instanceof Error ? error.message : String(error), [], [])
				stoppedAt = { failure, index }
				break
			}
		}

		/* A failing step blames its own operation whether or not the scenario covers it: a support
		 * step that fails (arming an account, setting the scene) must not stop the scenario in silence. */
		const failedOps = new Set(
			stoppedAt?.failure.blames.filter((id) => graded.includes(id) || input.mode === "full" || input.inScope(id)) ?? [],
		)
		for (const id of graded) {
			if (failedOps.has(id)) continue
			const call = calls.get(id)
			if (call === undefined) continue
			input.grades.graded([id], check)
			const observation = observed.get(id)
			input.grades.prove(id, observation === undefined ? { call: call.seq } : { call: call.seq, observation })
		}
		if (stoppedAt === null) continue

		const where = `scenario "${scenario.id}" stopped at step ${stoppedAt.index + 1}`
		if (failedOps.size > 0) {
			input.grades.graded([...failedOps], check)
			input.findings
				.attributed([...failedOps])
				.ownedBy(check)
				.backend(
					check,
					scenario.id,
					`${where}: ${stoppedAt.failure.message}`,
					stoppedAt.failure.message,
					stoppedAt.failure.evidence,
				)
		}
		const unreached = graded.filter((id) => !failedOps.has(id) && !calls.has(id))
		if (unreached.length > 0) {
			input.findings
				.attributed(unreached)
				.ownedBy(check)
				.blocked(check, scenario.id, `${where} before calling it`, `${where}: ${stoppedAt.failure.message}`)
		}

		async function runStep(step: ScenarioStep, index: number): Promise<void> {
			for (const [name, literal] of Object.entries("bind" in step && step.bind !== undefined ? step.bind : {})) {
				scope[name] = String(interpolate(literal, scope))
			}
			if (isOutOfBand(step)) {
				const address = String(interpolate(step.outOfBand.address, scope))
				const since = step.outOfBand.sentEarlier === true ? undefined : triggerSentAt(sent, address)
				scope[step.outOfBand.as] = await resolveOutOfBandValue(
					input.hooks.resolveOutOfBand,
					address,
					step.outOfBand.kind,
					{
						headers: headers(),
						label: `scenario "${scenario.id}"`,
						scope: { ...scope },
						...(since === undefined ? {} : { since }),
						...(input.outOfBand === undefined ? {} : { outOfBand: input.outOfBand }),
					},
				)
				return
			}
			if (isExternal(step)) {
				if (input.hooks.external === undefined) {
					throw new StepFailure(`step ${index + 1} needs hooks.external for "${step.external}"`, [], [])
				}
				const value = await input.hooks.external(
					step.external,
					interpolate(withObjects(step.input ?? {}), scope) as Record<string, unknown>,
				)
				if (value === null || value === "") {
					throw new StepFailure(`hooks.external("${step.external}") returned nothing`, [], [])
				}
				scope[step.as] = value
				if (/^\s*[[{]/.test(value)) {
					try {
						objects.set(step.as, JSON.parse(value))
					} catch {
						/* A string that only looks like JSON stays a string. */
					}
				}
				return
			}

			const own = stepOperation(step)
			const deadline = step.poll === undefined ? 0 : Date.now() + durationMs(step.poll.within)
			let waitMs = step.poll?.everyMs ?? 500
			for (;;) {
				const request = await resolveRequest(
					step.body === undefined ? step : { ...step, body: withObjects(step.body) },
					context,
					scope,
					index,
				)
				const exchange = await request.client.request(request.method, request.path, {
					...(request.body === undefined ? {} : { body: request.body }),
					...(request.contentType === undefined ? {} : { contentType: request.contentType }),
					headers: {
						...(step.anonymous === true
							? {}
							: step.principal === undefined
								? headers()
								: principalOf(step.principal).headers()),
						...request.headers,
					},
					...(request.query === undefined ? {} : { query: request.query }),
					...(own === undefined ? {} : { operationId: own }),
					...(request.redirect === undefined ? {} : { redirect: request.redirect }),
				})
				sent.push(exchange)
				const ok = succeeded(step, exchange)
				const want = step.assert === undefined ? null : expected(step.assert, scope)
				const shown = ok && (step.assert === undefined || want === null || holds(exchange, want.from, want))
				if (shown) {
					record(step, exchange, own, want)
					return
				}
				if (Date.now() < deadline) {
					await sleep(waitMs)
					waitMs = nextPollWait(waitMs, step.poll?.everyMs ?? 500)
					continue
				}
				const proves = [...(step.assert?.observes ?? []), ...(own === undefined ? [] : [own])]
				const earlier = proves
					.map((id) => calls.get(id))
					.filter((call): call is Exchange => call !== undefined && call !== exchange)
				if (!ok) {
					throw new StepFailure(
						`${request.method} ${request.path} returned ${exchange.status}`,
						[...earlier, exchange],
						own === undefined ? [] : [own],
					)
				}
				throw new StepFailure(
					`${request.method} ${request.path} did not show ${want?.mode} "${want?.value}" at ${want?.from}`,
					[...earlier, exchange],
					proves,
				)
			}
		}

		function record(step: ScenarioRequestStep, exchange: Exchange, own: string | undefined, want: Want | null): void {
			/* An observed call keeps its pair; a later repeat of the operation proves nothing new. */
			if (own !== undefined && !observed.has(own)) calls.set(own, exchange)
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
					throw new StepFailure(
						`saveAs.${name} = "${path}" is not in the response`,
						[exchange],
						own === undefined ? [] : [own],
					)
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
			if (step.saveClaimsFrom !== undefined) {
				const from = step.saveClaimsFrom.token
				const token =
					!from.startsWith("$") && scope[from] !== undefined ? scope[from] : readPath(exchange.responseBody, from)
				const claims = typeof token === "string" ? jwtClaims(token) : null
				if (claims === null) {
					throw new StepFailure(`saveClaimsFrom: no JWT at ${from}`, [exchange], own === undefined ? [] : [own])
				}
				for (const [name, claim] of Object.entries(step.saveClaimsFrom.bind)) {
					const value = readPath(claims, claim)
					if (value === undefined || value === null) {
						throw new StepFailure(
							`saveClaimsFrom: the token carries no "${claim}"`,
							[exchange],
							own === undefined ? [] : [own],
						)
					}
					scope[name] = String(value)
				}
			}
			if (step.assert === undefined || want === null) return
			const observation =
				want.mode === "excludes" || want.mode === "omits"
					? {
							absent: true as const,
							path: want.from,
							seq: exchange.seq,
							value: want.value,
						}
					: { path: want.from, seq: exchange.seq, value: shownValue(exchange, want.from, want) ?? want.value }
			/* A write's own response is its claim, not a later read of it: it proves nothing about itself. */
			const reads = /^(GET|HEAD)$/i.test(exchange.method)
			for (const id of [...(step.assert.observes ?? []), ...(own === undefined ? [] : [own])]) {
				if (!calls.has(id)) continue
				if (calls.get(id) === exchange && !reads) continue
				observed.set(id, observation)
			}
		}
	}
}
