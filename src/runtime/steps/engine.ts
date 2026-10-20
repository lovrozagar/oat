/*
 * The step engine. A chain of steps runs against a scope: each step is an operation from the
 * document, a raw request, or a value delivered outside HTTP, and what an answer carries is bound
 * by path for the steps after it. The engine returns the scope and the last answer; what the
 * caller makes of them, a credential say, is the caller's to read.
 */

import type { AuthStep, OutOfBandStep } from "../../config/types/steps.ts"
import { readSaveAs } from "../cookies/save-as.ts"
import { cookiesFromRecordedHeaders } from "../cookies/set-cookie.ts"
import type { Exchange } from "../exchange.ts"
import { readPath } from "../../client/read-path.ts"
import { interpolate } from "./interpolate.ts"
import { jwtClaims } from "../../credentials/jwt.ts"
import { claimsToken } from "./jwt.ts"
import { resolveOutOfBandValue, triggerSentAt } from "./out-of-band.ts"
import { type ResolvedRequest, resolveRequest, type StepContext } from "./request.ts"

type Scope = Record<string, string>

/** An answer as the steps read it. */
export interface StepAnswer {
	status: number
	body: unknown
	headers: Record<string, string>
	cookies: Record<string, string>
}

/** How a chain starts. */
export interface RunStepsOptions {
	/** Bindings the chain starts from; copied, never written. */
	scope?: Readonly<Scope>
}

/** One step's place in the chain and the state it reads and writes. */
interface Turn {
	index: number
	scope: Scope
}

/** Runs `steps` in order, returning the bound scope and the last answer (none when nothing was sent). */
export async function runSteps(
	ctx: StepContext,
	steps: readonly AuthStep[],
	options: RunStepsOptions = {},
): Promise<{ scope: Scope; last: StepAnswer | undefined }> {
	const scope: Scope = { ...options.scope }
	const sent: Exchange[] = []
	let last: StepAnswer | undefined
	for (const [index, step] of steps.entries()) {
		const turn: Turn = { index, scope }
		bindLiterals(step, scope)
		if ("outOfBand" in step) {
			scope[step.outOfBand.as] = await awaitDelivery(ctx, step, { sent, turn })
			continue
		}
		const exchange = await send(ctx, step, turn)
		sent.push(exchange)
		last = answerOf(exchange)
		saveAnswer(ctx, step, { answer: last, turn })
	}
	return { last, scope }
}

/** A step's `bind` literals, filled from the scope before the step runs. */
function bindLiterals(step: AuthStep, scope: Scope): void {
	const stepBind = "bind" in step ? step.bind : undefined
	for (const [name, literal] of Object.entries(stepBind ?? {})) {
		scope[name] = String(interpolate(literal, scope))
	}
}

/** The value an out-of-band step waits for, asked of the hook. */
async function awaitDelivery(
	ctx: StepContext,
	step: OutOfBandStep,
	at: { sent: readonly Exchange[]; turn: Turn },
): Promise<string> {
	const { scope } = at.turn
	const address = String(interpolate(step.outOfBand.address, scope))
	const since = step.outOfBand.sentEarlier === true ? undefined : triggerSentAt(at.sent, address)
	return resolveOutOfBandValue(ctx.hooks.resolveOutOfBand, address, {
		kind: step.outOfBand.kind,
		label: `principal "${ctx.principalId}"`,
		scope: { ...scope },
		...(since === undefined ? {} : { since }),
		...(ctx.outOfBand === undefined ? {} : { outOfBand: ctx.outOfBand }),
	})
}

/** Sends an HTTP step and fails closed on a status it does not accept. */
async function send(ctx: StepContext, step: AuthStep, turn: Turn): Promise<Exchange> {
	const request = await resolveRequest(ctx, step, turn.scope, turn.index)
	const exchange = await request.client.request(request.method, request.path, {
		...(request.body === undefined ? {} : { body: request.body }),
		...(request.contentType === undefined ? {} : { contentType: request.contentType }),
		headers: request.headers ?? {},
		...(request.query === undefined ? {} : { query: request.query }),
		/* A login or refresh hop acts as nobody, and is never refreshed or retried: a hop that
		 * refreshed would wait on its own login. What it sends is what the step names. */
		as: { anonymous: true },
		probe: true,
		...("operationId" in step ? { operationId: step.operationId } : {}),
		...(request.redirect === undefined ? {} : { redirect: request.redirect }),
	})
	accept(ctx, step, { exchange, index: turn.index, request })
	return exchange
}

/** Throws unless the status is one the step expects, or any 2xx when it names none. */
function accept(
	ctx: StepContext,
	step: AuthStep,
	sent: { exchange: Exchange; index: number; request: ResolvedRequest },
): void {
	const { exchange, request } = sent
	const acceptable = ("expect" in step ? step.expect : undefined) ?? []
	const ok = acceptable.length > 0 ? acceptable.includes(exchange.status) : exchange.status < 300
	if (ok) return
	throw new Error(
		`oat: principal "${ctx.principalId}" failed at auth step ${sent.index + 1} ` +
			`(${request.method} ${request.path}): expected ` +
			`${acceptable.length > 0 ? acceptable.join("/") : "2xx"}, got ${exchange.status} — ` +
			`${JSON.stringify(exchange.responseBody).slice(0, 200)}`,
	)
}

/** An exchange as a step, or a recipe, reads its answer, with the cookies its hops set. */
export function answerOf(exchange: Exchange): StepAnswer {
	return {
		body: exchange.responseBody,
		cookies: exchange.cookies ?? cookiesFromRecordedHeaders(exchange.responseHeaders),
		headers: exchange.responseHeaders,
		status: exchange.status,
	}
}

/** Binds a step's `saveAs` paths, then its `saveClaimsFrom` claims, from the answer. */
function saveAnswer(ctx: StepContext, step: AuthStep, at: { answer: StepAnswer; turn: Turn }): void {
	const { answer, turn } = at
	const saveAs = "saveAs" in step ? step.saveAs : undefined
	for (const [name, template] of Object.entries(saveAs ?? {})) {
		const path = String(interpolate(template, turn.scope))
		const value = readSaveAs(path, {
			body: answer.body,
			cookies: answer.cookies,
			headers: answer.headers,
			readJson: readPath,
		})
		if (value === undefined || value === null) {
			throw new Error(
				`oat: auth step ${turn.index + 1} for "${ctx.principalId}" declares saveAs.${name} = ` +
					`"${path}", which is not present in the response`,
			)
		}
		turn.scope[name] = String(value)
	}
	const saveClaimsFrom = "saveClaimsFrom" in step ? step.saveClaimsFrom : undefined
	if (saveClaimsFrom !== undefined) saveClaims(ctx, saveClaimsFrom, { answer, turn })
}

/** Binds claims out of the JWT a step's answer (or the scope) carries. */
function saveClaims(
	ctx: StepContext,
	from: { token: string; bind: Record<string, string> },
	at: { answer: StepAnswer; turn: Turn },
): void {
	const { index, scope } = at.turn
	const token = claimsToken(from.token, at.answer.body, scope)
	const claims = typeof token === "string" ? jwtClaims(token) : null
	if (claims === null) {
		throw new Error(
			`oat: auth step ${index + 1} for "${ctx.principalId}" expected a JWT at ` +
				`${from.token}, but it is absent or not decodable`,
		)
	}
	for (const [name, claimPath] of Object.entries(from.bind)) {
		const value = readPath(claims, claimPath)
		if (value === undefined || value === null) {
			throw new Error(
				`oat: auth step ${index + 1} binds ${name} to claim "${claimPath}", which the token ` +
					`does not carry. Available claims: ${Object.keys(claims).join(", ")}`,
			)
		}
		scope[name] = String(value)
	}
}
