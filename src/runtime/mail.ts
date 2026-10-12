/**
 * A write whose body is a token spends a value that arrived out of band. The sender is the
 * other POST under the same path, the token comes from `resolveOutOfBand`, and the call
 * passes only when a follow-up read shows a result of this call. The suite caller is never
 * the address.
 */

import type { AuthFlow, Hooks, PrincipalAuth } from "../config/define-config.ts"
import type { Client, Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import { buildCohort } from "./fixture.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { GradeLedger } from "./scope.ts"
import type { OutOfBandRequest } from "../config/define-config.ts"
import type { BackoffConfig } from "./poll.ts"
import { isAbsentValue, pollWithBackoff, resolveBackoff, sleep } from "./poll.ts"
import { fillPath, requestSchemaOf } from "./world.ts"

export const MAIL_CHECK_ID = "mail.token-changes-the-caller"

const SKIP_SEGMENT = new Set(["v1", "auth", "api"])

export interface MailPair {
	sender: OperationModel
	consumer: OperationModel
}

export function mailPairs(model: SpecModel): MailPair[] {
	const pairs: MailPair[] = []
	for (const consumer of model.operations) {
		if (
			consumer.method !== "POST" &&
			!(consumer.method === "GET" && consumer.invalidates.some((item) => item.startsWith("GET ")))
		)
			continue
		if (spentField(consumer, model) === null) continue
		const sender = senderFor(model, consumer)
		if (sender === undefined) continue
		pairs.push({ consumer, sender })
	}
	return pairs
}

/** Hint for the out-of-band hook: summary code phrase, otherwise the path words. */
export function mailHint(model: SpecModel, op: OperationModel): string {
	const summary = model.rawOperations.get(op.operationId)?.summary
	if (typeof summary === "string") {
		const named = summary.toLowerCase().match(/[a-z]+ code/)
		if (named !== null) return named[0].replace(" ", "-")
	}
	return op.path
		.split("/")
		.filter((segment) => segment !== "" && !segment.startsWith("{") && !SKIP_SEGMENT.has(segment))
		.join(" ")
}

export async function runMailOps(input: {
	auth: () => Record<string, string>
	authFlow?: PrincipalAuth
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	hooks?: Hooks
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	nonce?: string
	outOfBand?: Partial<BackoffConfig>
	roots?: Record<string, string>
	seed?: number
}): Promise<void> {
	if (input.hooks?.resolveOutOfBand === undefined) return
	const pairs = mailPairs(input.model).filter((pair) => pairSelected(input, pair))
	await runInviteScenes(input)
	if (pairs.length === 0) return
	const read = callerRead(input.model)
	const flow = authFlowOf(input.authFlow)
	const domain = flow === null ? "example.test" : domainOf(signupEmail(flow))
	const password = flow === null ? "secret" : (signupPassword(flow) ?? "secret")
	let sequence = 0
	for (const pair of pairs) {
		if (pair.sender.path.includes("{") || pair.consumer.path.includes("{")) continue
		const spent = spentField(pair.consumer, input.model)
		const hasRead = pair.consumer.invalidates.some((item) => item.startsWith("GET "))
		if (spent !== "token" && !hasRead) continue
		const readOp = invalidatedOperation(input.model, pair.consumer)
		const targetedRead =
			input.mode === "targeted" &&
			readOp !== undefined &&
			input.inScope(readOp.operationId) &&
			!input.inScope(pair.sender.operationId) &&
			!input.inScope(pair.consumer.operationId)
		const ids = [pair.sender.operationId, pair.consumer.operationId]
		if (targetedRead && readOp !== undefined) ids.push(readOp.operationId)
		const blame = input.findings.attributed(ids).ownedBy(MAIL_CHECK_ID)
		const email = `oat-mail-${input.nonce ?? "user"}-${sequence}@${domain}`
		sequence += 1
		const nextEmail = `oat-mail-next-${input.nonce ?? "user"}-${sequence}@${domain}`
		const senderProps = propertyBag(requestSchemaOf(pair.sender, input.model))
		const needsAccount =
			pair.sender.securitySchemes.includes("jwt") || "email" in senderProps || pathHas(pair.sender, "reset")
		let headers: (() => Record<string, string>) | undefined
		if (needsAccount) {
			const opened = await openAccount(input, email, password)
			if (opened === null) {
				blame.backend(
					MAIL_CHECK_ID,
					"caller",
					"the mail account could not be opened",
					`${pair.sender.operationId} had no account to mail.`,
					[],
				)
				input.grades.graded(ids, MAIL_CHECK_ID)
				continue
			}
			headers = opened
		}
		const sent = await senderBody(input, pair.sender, email, nextEmail)
		const hint = mailHint(input.model, pair.sender)
		const stale = await peekMail(input, email, hint)
		let called = await postSender(input, pair.sender, sent, headers)
		if (unverified(called) && headers !== undefined) {
			const upgraded = await adoptVerifiedSession(input, email, headers, password)
			if (upgraded !== null) {
				headers = upgraded
				called = await postSender(input, pair.sender, sent, headers)
			}
		}
		if (needsReauth(called) && headers !== undefined) {
			await reauth(input, headers, password)
			called = await postSender(input, pair.sender, sent, headers)
		}
		if (called.status < 200 || called.status >= 300) {
			blame.backend(
				MAIL_CHECK_ID,
				"caller",
				"the mail was not sent",
				`${pair.sender.operationId} returned ${called.status}.`,
				[called],
			)
			input.grades.graded(ids, MAIL_CHECK_ID)
			continue
		}
		let seen = stale
		let token: string | null = null
		let before: Exchange | null = null
		let posted: string[] = []
		const consumed: Exchange[] = []
		let missing = false
		let refused = false
		for (let attempt = 0; attempt < 4; attempt++) {
			const raw = await mailed(input, email, hint, seen)
			if (raw === null) {
				missing = token === null
				refused = token !== null
				break
			}
			token = tokenFrom(raw)
			if (before === null) before = await invalidatedRead(input, pair.consumer, token, headers)
			const round = await consume(input, pair.consumer, token, headers, password, stringIds(before?.responseBody))
			consumed.push(...round.exchanges)
			posted = round.posted
			const lastRound = round.exchanges.at(-1)
			if (lastRound !== undefined && lastRound.status >= 200 && lastRound.status < 300) break
			if (lastRound !== undefined && tokenRejected(lastRound) && attempt < 3) {
				seen = raw
				continue
			}
			refused = true
			break
		}
		if (missing || token === null) {
			blame.backend(
				MAIL_CHECK_ID,
				"caller",
				"the mail never arrived",
				`${pair.sender.operationId} returned ${called.status} and no out-of-band token followed.`,
				[called, ...consumed],
			)
			input.grades.graded(ids, MAIL_CHECK_ID)
			continue
		}
		const last = consumed.at(-1)
		if (refused || last === undefined || last.status < 200 || last.status >= 300) {
			blame.backend(
				MAIL_CHECK_ID,
				"caller",
				"the mailed token was refused",
				`${pair.consumer.operationId} returned ${last?.status ?? 0}.`,
				[called, ...consumed],
			)
			input.grades.graded(ids, MAIL_CHECK_ID)
			continue
		}
		const proof = await followUpShows(input, pair, last, token, before, headers, nextEmail, read)
		const shown = proof.ok && bodyShowsPosted(proof.after?.responseBody, posted)
		if (!proof.ok) {
			blame.backend(
				MAIL_CHECK_ID,
				read?.entity ?? "caller",
				"the follow-up did not show the mailed change",
				`${pair.consumer.operationId} returned ${last.status}, and the follow-up read did not show this call.`,
				[called, ...consumed],
			)
		} else if (targetedRead && readOp !== undefined && !shown) {
			blame.backend(
				MAIL_CHECK_ID,
				readOp.entity ?? "caller",
				"the follow-up read did not show this call",
				`${readOp.operationId} returned ${proof.after?.status ?? 0}, and the body did not contain the value this call set.`,
				[called, ...consumed, ...(proof.after === null ? [] : [proof.after])],
			)
		} else if (shown && readOp !== undefined && !ids.includes(readOp.operationId)) {
			ids.push(readOp.operationId)
		}
		const suite =
			read === undefined
				? undefined
				: await input.client.request(read.method, read.path, {
						headers: input.auth,
						operationId: read.operationId,
					})
		if (suite !== undefined && suite.status !== 200) {
			blame.backend(
				MAIL_CHECK_ID,
				read?.entity ?? "caller",
				"the suite caller was logged out",
				`${pair.consumer.operationId} ran for ${email}, and the suite ${read?.operationId} then returned ${suite.status}.`,
				[last, suite],
			)
		}
		input.grades.graded(ids, MAIL_CHECK_ID)
	}
}

function senderFor(model: SpecModel, consumer: OperationModel): OperationModel | undefined {
	let best: OperationModel | undefined
	let bestScore = -1
	for (const op of model.operations) {
		if (op.operationId === consumer.operationId || op.method !== "POST") continue
		if (spentField(op, model) !== null) continue
		const score = pairScore(op.path, consumer.path)
		if (score > bestScore) {
			best = op
			bestScore = score
		}
	}
	return bestScore < 0 ? undefined : best
}

function pairScore(sender: string, consumer: string): number {
	if (consumer === sender || consumer.startsWith(`${sender}/`)) return 10_000 + sender.length
	if (sender === `${consumer}/code`) return 9_000 + consumer.length
	const tail = staticSegments(sender).at(-1)
	if (tail !== undefined && tail.length >= 8 && staticSegments(consumer).includes(tail)) {
		return 8_000 + tail.length
	}
	const prefix = commonPrefix(sender, consumer)
	const segments = prefix.split("/").filter(Boolean).length
	if (segments < 2) return -1
	if (segments < 3 && !siblingPair(sender, consumer)) return -1
	const extra = sender.split("/").filter(Boolean).length - segments
	return prefix.length * 100 - extra
}

function siblingPair(sender: string, consumer: string): boolean {
	const left = sender.split("/").filter(Boolean)
	const right = consumer.split("/").filter(Boolean)
	if (left.length !== 3 || right.length !== 3) return false
	if (left.some((part) => part.startsWith("{")) || right.some((part) => part.startsWith("{"))) return false
	return left[0] === right[0] && left[1] === right[1] && left[2] !== right[2]
}

function staticSegments(path: string): string[] {
	return path.split("/").filter((part) => part !== "" && !part.startsWith("{"))
}

function commonPrefix(left: string, right: string): string {
	const limit = Math.min(left.length, right.length)
	let index = 0
	while (index < limit && left[index] === right[index]) index++
	return left.slice(0, index)
}

function spentField(op: OperationModel, model: SpecModel): string | null {
	if (requiresToken(op, model)) return "token"
	const child = model.operations.some((item) => item.method === "POST" && item.path === `${op.path}/code`)
	if (!child) return null
	const name = Object.keys(propertyBag(requestSchemaOf(op, model))).find(
		(key) => key === "code" || key.endsWith("_code"),
	)
	return name ?? null
}

function requiresToken(op: OperationModel, model: SpecModel): boolean {
	const required = requiredNames(requestSchemaOf(op, model))
	if (required.includes("token")) return true
	const parameters = model.rawOperations.get(op.operationId)?.parameters
	if (!Array.isArray(parameters)) return false
	return parameters.some((parameter) => {
		if (parameter === null || typeof parameter !== "object") return false
		const record = parameter as { in?: unknown; name?: unknown; required?: unknown }
		return record.in === "query" && record.name === "token" && record.required !== false
	})
}

function pathHas(op: OperationModel, word: string): boolean {
	return op.path.toLowerCase().includes(word)
}

async function openAccount(
	input: { client: Client; model: SpecModel },
	email: string,
	password: string,
): Promise<(() => Record<string, string>) | null> {
	const register = input.model.operations.find((op) => {
		if (/passkey/i.test(op.path) || /passkey/i.test(op.operationId)) return false
		const props = propertyBag(requestSchemaOf(op, input.model))
		return (
			"email" in props &&
			("password" in props || op.freshPrincipal === true) &&
			/register|sign/i.test(`${op.operationId} ${op.path}`)
		)
	})
	if (register === undefined) return null
	const props = propertyBag(requestSchemaOf(register, input.model))
	const body: Record<string, unknown> = { email }
	if ("password" in props) body.password = password
	const opened = await input.client.request(register.method, register.path, {
		body,
		headers: {},
		operationId: register.operationId,
	})
	const token = stringField(opened.responseBody, "access_token")
	if (opened.status < 200 || opened.status >= 300 || token === null) return null
	return () => ({ authorization: `Bearer ${token}` })
}

async function senderBody(
	input: { model: SpecModel; seed?: number },
	op: OperationModel,
	email: string,
	nextEmail: string,
): Promise<Record<string, unknown>> {
	const schema = requestSchemaOf(op, input.model)
	const body = generatedBody(schema, input.seed ?? 1, op.operationId)
	if ("email" in propertyBag(schema)) body.email = email
	if ("new_email" in propertyBag(schema)) body.new_email = nextEmail
	return body
}

async function consume(
	input: { client: Client; model: SpecModel; seed?: number },
	op: OperationModel,
	token: string,
	headers: (() => Record<string, string>) | undefined,
	password: string,
	ids: string[] = [],
): Promise<{ exchanges: Exchange[]; posted: string[] }> {
	const schema = requestSchemaOf(op, input.model)
	const enums = enumFields(schema).filter((field) => field.name !== "token")
	const rounds = enums.length === 0 ? [undefined] : enums.flatMap((field) => field.values)
	const exchanges: Exchange[] = []
	let posted: string[] = []
	for (const value of rounds) {
		const body = generatedBody(schema, input.seed ?? 1, op.operationId)
		const spent = spentField(op, input.model)
		if (spent !== null && spent !== "token") {
			for (const key of Object.keys(body)) if (key !== spent) delete body[key]
		}
		if (spent !== null && spent in propertyBag(schema)) body[spent] = token
		applyListedIds(body, schema, ids)
		if (spent === "token" && "password" in propertyBag(schema)) body.password = `${password}2`
		if (enums.length > 0 && value !== undefined) {
			for (const field of enums) body[field.name] = value
		}
		const query = queryToken(op, input.model) ? { token } : undefined
		let path = op.path
		try {
			path = fillPath(op.path, {})
		} catch {
			return { exchanges, posted }
		}
		exchanges.push(
			await input.client.request(op.method, path, {
				...(Object.keys(body).length === 0 ? {} : { body }),
				...(query === undefined ? {} : { query }),
				...(headers === undefined ? {} : { headers }),
				operationId: op.operationId,
			}),
		)
		const status = exchanges.at(-1)?.status ?? 0
		if (status >= 200 && status < 300) posted = postedValues(body)
	}
	return { exchanges, posted }
}

async function followUpShows(
	input: { auth: () => Record<string, string>; client: Client; model: SpecModel },
	pair: MailPair,
	last: Exchange,
	token: string,
	before: Exchange | null,
	headers: (() => Record<string, string>) | undefined,
	nextEmail: string,
	read: OperationModel | undefined,
): Promise<{ ok: boolean; after: Exchange | null }> {
	const access = stringField(last.responseBody, "access_token")
	if (access !== null && read !== undefined) {
		const profile = await input.client.request(read.method, read.path, {
			headers: { authorization: `Bearer ${access}` },
			operationId: read.operationId,
		})
		if (profile.status !== 200) return { ok: false, after: null }
		if ("new_email" in propertyBag(requestSchemaOf(pair.sender, input.model))) {
			return { ok: JSON.stringify(profile.responseBody).includes(nextEmail), after: profile }
		}
		/* A session alone does not prove a write that claims to change the caller read. */
		if (pair.consumer.invalidates.includes(`${read.method} ${read.path}`)) {
			if (before === null || before.status < 200 || before.status >= 300) return { ok: false, after: null }
			const after = await invalidatedRead(input, pair.consumer, token, headers)
			if (after === null || after.status < 200 || after.status >= 300) return { ok: false, after }
			return { ok: JSON.stringify(before.responseBody) !== JSON.stringify(after.responseBody), after }
		}
		return { ok: true, after: profile }
	}
	const after = await invalidatedRead(input, pair.consumer, token, headers)
	if (after === null || after.status < 200 || after.status >= 300) return { ok: false, after }
	if (before === null) return { ok: true, after }
	return {
		ok: before.status !== after.status || JSON.stringify(before.responseBody) !== JSON.stringify(after.responseBody),
		after,
	}
}

function invalidatedOperation(model: SpecModel, op: OperationModel): OperationModel | undefined {
	const named = op.invalidates.find((item) => item.startsWith("GET "))
	if (named === undefined) return undefined
	const path = named.slice(4).replaceAll(": ", "/").replaceAll(":", "/")
	return model.operations.find((item) => item.method === "GET" && (item.path === path || item.route === named))
}

function pairSelected(
	input: { inScope: (operationId: string) => boolean; mode: "full" | "targeted"; model: SpecModel },
	pair: MailPair,
): boolean {
	if (input.mode === "full") return true
	if (input.inScope(pair.sender.operationId) || input.inScope(pair.consumer.operationId)) return true
	const read = invalidatedOperation(input.model, pair.consumer)
	return read !== undefined && input.inScope(read.operationId) && consumerSetsValue(pair.consumer, input.model)
}

function consumerSetsValue(op: OperationModel, model: SpecModel): boolean {
	return Object.keys(propertyBag(requestSchemaOf(op, model))).some(
		(key) => key !== "token" && key !== "password" && key !== "code" && !key.endsWith("_code"),
	)
}

function postedValues(body: Record<string, unknown>): string[] {
	const out: string[] = []
	const walk = (value: unknown) => {
		if (typeof value === "string") {
			if (value !== "") out.push(value)
			return
		}
		if (Array.isArray(value)) for (const item of value) walk(item)
	}
	for (const [key, value] of Object.entries(body)) {
		if (key === "token" || key === "password") continue
		walk(value)
	}
	return out
}

function bodyShowsPosted(body: unknown, posted: readonly string[]): boolean {
	if (posted.length === 0) return false
	const text = JSON.stringify(body)
	return typeof text === "string" && posted.every((value) => text.includes(value))
}

async function invalidatedRead(
	input: { client: Client; model: SpecModel },
	op: OperationModel,
	token: string,
	headers: (() => Record<string, string>) | undefined,
): Promise<Exchange | null> {
	const named = op.invalidates.find((item) => item.startsWith("GET "))
	if (named === undefined) return null
	const path = named.slice(4).replaceAll(": ", "/").replaceAll(":", "/")
	const target = invalidatedOperation(input.model, op)
	const query = target !== undefined && queryToken(target, input.model) ? { token } : undefined
	return input.client.request("GET", path, {
		...(query === undefined ? {} : { query }),
		...(headers === undefined ? {} : { headers }),
		...(target === undefined ? {} : { operationId: target.operationId }),
	})
}

const RATE_LIMIT_WAIT_MS = 13_000

async function postSender(
	input: { client: Client },
	op: OperationModel,
	body: Record<string, unknown>,
	headers: (() => Record<string, string>) | undefined,
	path = op.path,
): Promise<Exchange> {
	let called: Exchange | undefined
	for (let attempt = 0; attempt < 4; attempt++) {
		called = await input.client.request(op.method, path, {
			...(Object.keys(body).length === 0 ? {} : { body }),
			...(headers === undefined ? {} : { headers }),
			operationId: op.operationId,
		})
		if (called.status !== 429 || attempt === 3) return called
		await sleep(RATE_LIMIT_WAIT_MS)
	}
	return called as Exchange
}

function unverified(exchange: Exchange): boolean {
	if (exchange.status !== 403) return false
	const key = errorKey(exchange.responseBody)
	return key.includes("verif") && !key.includes("already")
}

function needsReauth(exchange: Exchange): boolean {
	return exchange.status === 403 && errorKey(exchange.responseBody).includes("reauth")
}

async function adoptVerifiedSession(
	input: {
		client: Client
		hooks?: Hooks
		model: SpecModel
		outOfBand?: Partial<BackoffConfig>
		seed?: number
	},
	email: string,
	headers: () => Record<string, string>,
	password: string,
): Promise<(() => Record<string, string>) | null> {
	const pair = mailPairs(input.model).find((item) => {
		const path = item.consumer.path.toLowerCase()
		return path.includes("verify") && !path.includes("change")
	})
	if (pair === undefined) return null
	const hint = mailHint(input.model, pair.sender)
	const stale = await peekMail(input, email, hint)
	const sent = await senderBody(input, pair.sender, email, email)
	const called = await postSender(input, pair.sender, sent, headers)
	if (called.status < 200 || called.status >= 300) return null
	let seen = stale
	for (let attempt = 0; attempt < 4; attempt++) {
		const raw = await mailed(input, email, hint, seen)
		if (raw === null) return null
		const round = await consume(input, pair.consumer, tokenFrom(raw), headers, password)
		const last = round.exchanges.at(-1)
		if (last !== undefined && last.status >= 200 && last.status < 300) {
			const access = stringField(last.responseBody, "access_token")
			if (access === null) return headers
			return () => ({ authorization: `Bearer ${access}` })
		}
		if (last !== undefined && tokenRejected(last) && attempt < 3) {
			seen = raw
			continue
		}
		return null
	}
	return null
}

async function reauth(
	input: { client: Client; model: SpecModel },
	headers: () => Record<string, string>,
	password: string,
): Promise<void> {
	const op = input.model.operations.find(
		(item) => /\/reauth$/.test(item.path) && "password" in propertyBag(requestSchemaOf(item, input.model)),
	)
	if (op === undefined) return
	await input.client.request(op.method, op.path, {
		body: { password },
		headers,
		operationId: op.operationId,
	})
}

async function peekMail(input: { hooks?: Hooks }, address: string, kind: string): Promise<string | null> {
	if (input.hooks?.resolveOutOfBand === undefined) return null
	try {
		const value = await input.hooks.resolveOutOfBand(outOfBandRequest(address, kind, 1))
		return typeof value === "string" && value !== "" ? value : null
	} catch {
		return null
	}
}

async function mailed(
	input: { hooks?: Hooks; outOfBand?: Partial<BackoffConfig> },
	address: string,
	kind: string,
	stale: string | null,
): Promise<string | null> {
	if (input.hooks?.resolveOutOfBand === undefined) return null
	try {
		const value = await pollWithBackoff(
			(attempt) => input.hooks?.resolveOutOfBand?.(outOfBandRequest(address, kind, attempt)) ?? Promise.resolve(null),
			resolveBackoff(input.outOfBand),
			(item) => isAbsentValue(item) || item === stale,
		)
		return typeof value === "string" && value !== "" && value !== stale ? value : null
	} catch {
		return null
	}
}

function outOfBandRequest(address: string, kind: string, attempt: number): OutOfBandRequest {
	return { address, attempt, headers: {}, kind, scope: {} }
}

function generatedBody(
	schema: Record<string, unknown> | null,
	seed: number,
	operationId: string,
): Record<string, unknown> {
	if (schema === null) return {}
	try {
		const [member] = buildCohort(schema, seed, ["baseline"], operationId, { distinct: propertyNames(schema) })
		return member?.body ?? {}
	} catch {
		return {}
	}
}

function enumFields(schema: Record<string, unknown> | null): Array<{ name: string; values: string[] }> {
	const props = propertyBag(schema)
	const out: Array<{ name: string; values: string[] }> = []
	for (const [name, value] of Object.entries(props)) {
		if (value === null || typeof value !== "object") continue
		const values = (value as { enum?: unknown }).enum
		if (!Array.isArray(values)) continue
		const strings = values.filter((item): item is string => typeof item === "string")
		if (strings.length > 0) out.push({ name, values: strings })
	}
	return out
}

function queryToken(op: OperationModel, model: SpecModel): boolean {
	return (
		op.queryParamNames.includes("token") ||
		(requiresToken(op, model) && !("token" in propertyBag(requestSchemaOf(op, model))))
	)
}

function callerRead(model: SpecModel): OperationModel | undefined {
	const reads = model.operations.filter(
		(op) => op.identity === "self" && op.action === "read" && op.pathParams.length === 0,
	)
	return reads.find((op) => op.path.endsWith("/me")) ?? reads[0]
}

function authFlowOf(auth: PrincipalAuth | undefined): AuthFlow | null {
	if (auth === undefined || !("steps" in auth)) return null
	return auth
}

function signupEmail(spec: AuthFlow): string | undefined {
	for (const step of spec.steps) {
		if ("body" in step && step.body !== null && typeof step.body === "object" && "email" in step.body) {
			const email = (step.body as { email?: unknown }).email
			if (typeof email === "string") return email
		}
	}
	return undefined
}

function signupPassword(spec: AuthFlow): string | undefined {
	for (const step of spec.steps) {
		if ("body" in step && step.body !== null && typeof step.body === "object" && "password" in step.body) {
			const password = (step.body as { password?: unknown }).password
			if (typeof password === "string") return password
		}
	}
	return undefined
}

function domainOf(email: string | undefined): string {
	if (email === undefined) return "example.test"
	const at = email.lastIndexOf("@")
	return at > 0 ? email.slice(at + 1) : "example.test"
}

function propertyBag(schema: Record<string, unknown> | null): Record<string, unknown> {
	if (schema === null) return {}
	const properties = schema.properties
	if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return {}
	return properties as Record<string, unknown>
}

function propertyNames(schema: Record<string, unknown>): Set<string> {
	return new Set(Object.keys(propertyBag(schema)))
}

function requiredNames(schema: Record<string, unknown> | null): string[] {
	if (schema === null || !Array.isArray(schema.required)) return []
	return schema.required.filter((name): name is string => typeof name === "string")
}

function tokenFrom(value: string): string {
	try {
		const token = new URL(value).searchParams.get("token")
		if (token !== null && token !== "") return token
	} catch {
		/* A bare token is already the value the consumer posts. */
	}
	return value
}

function stringField(body: unknown, key: string): string | null {
	if (body === null || typeof body !== "object") return null
	const value = (body as Record<string, unknown>)[key]
	return typeof value === "string" && value !== "" ? value : null
}

function errorKey(body: unknown): string {
	return stringField(body, "error_key") ?? ""
}

function stringIds(body: unknown): string[] {
	const ids: string[] = []
	const walk = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const item of value) walk(item)
			return
		}
		if (value === null || typeof value !== "object") return
		const record = value as Record<string, unknown>
		if (typeof record.id === "string" && record.id !== "") ids.push(record.id)
		for (const child of Object.values(record)) walk(child)
	}
	walk(body)
	return ids
}

function applyListedIds(body: Record<string, unknown>, schema: Record<string, unknown> | null, ids: string[]): void {
	for (const [name, value] of Object.entries(propertyBag(schema))) {
		if (value === null || typeof value !== "object") continue
		const record = value as { items?: { type?: unknown }; type?: unknown }
		if (record.type === "array" && record.items?.type === "string") body[name] = ids
	}
}

function rowsOf(body: unknown): Array<Record<string, unknown>> {
	const rows: Array<Record<string, unknown>> = []
	const walk = (value: unknown) => {
		if (Array.isArray(value)) {
			for (const item of value) {
				if (item !== null && typeof item === "object" && !Array.isArray(item)) {
					const record = item as Record<string, unknown>
					if (typeof record.id === "string") rows.push(record)
				}
				walk(item)
			}
			return
		}
		if (value !== null && typeof value === "object") {
			for (const child of Object.values(value as Record<string, unknown>)) walk(child)
		}
	}
	walk(body)
	return rows
}

function tokenRejected(exchange: Exchange): boolean {
	if (exchange.status < 400 || exchange.status >= 500) return false
	const key = errorKey(exchange.responseBody)
	return key.includes("token") || key.includes("code") || key.includes("expired")
}

type MailInput = Parameters<typeof runMailOps>[0]

async function runInviteScenes(input: MailInput): Promise<void> {
	if (input.mode !== "targeted") return
	await runCollaboratorScene(input)
	await runDeclineScene(input)
}

async function runCollaboratorScene(input: MailInput): Promise<void> {
	const invite = input.model.operations.find(
		(op) =>
			op.method === "POST" &&
			op.invite !== null &&
			staticSegments(op.path).includes("collaborators") &&
			!op.path.includes("resend"),
	)
	if (invite?.invite == null) return
	const accept = input.model.byOperationId.get(invite.invite.accept)
	const resend = input.model.operations.find(
		(op) => op.method === "POST" && op.path.endsWith("/resend") && staticSegments(op.path).includes("collaborators"),
	)
	const players = [invite, accept, resend].filter((op): op is OperationModel => op !== undefined)
	const ids = inPlay(input, players)
	if (ids.length === 0) return
	const blame = input.findings.attributed(ids).ownedBy(MAIL_CHECK_ID)
	const roots = input.roots ?? {}
	let invitePath: string
	try {
		invitePath = fillPath(invite.path, roots)
	} catch {
		blame.backend(MAIL_CHECK_ID, "caller", "the invite had no project", `${invite.operationId} had no project id.`, [])
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	const { email, headers, password } = await mailedAccount(input, "collab")
	if (headers === null) {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the mail account could not be opened",
			`${invite.operationId} had no account.`,
			[],
		)
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	const sent = await senderBody(input, invite, email, email)
	const grantee = invite.invite.granteeField
	if (grantee in propertyBag(requestSchemaOf(invite, input.model))) sent[grantee] = email
	const hint = invite.invite.tokenKind ?? mailHint(input.model, invite)
	const stale = await peekMail(input, email, hint)
	const called = await postSender(input, invite, sent, input.auth, invitePath)
	if (called.status < 200 || called.status >= 300) {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the invite was not sent",
			`${invite.operationId} returned ${called.status}.`,
			[called],
		)
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	const first = await mailed(input, email, hint, stale)
	let current = first
	if (resend !== undefined && (input.mode === "full" || input.inScope(resend.operationId))) {
		const proved = await resendCollaborator(input, resend, roots, email)
		if (!proved) {
			input.findings
				.attributed([resend.operationId])
				.ownedBy(MAIL_CHECK_ID)
				.backend(
					MAIL_CHECK_ID,
					"caller",
					"the resent invite did not change the member",
					`${resend.operationId} did not change the member row.`,
					[called],
				)
		}
		input.grades.graded([resend.operationId], MAIL_CHECK_ID)
		const rotated = await mailed(input, email, hint, first)
		if (rotated !== null) current = rotated
	}
	if (accept !== undefined && (input.mode === "full" || input.inScope(accept.operationId))) {
		const token = current === null ? null : tokenFrom(current)
		if (token === null) {
			input.findings
				.attributed([accept.operationId])
				.ownedBy(MAIL_CHECK_ID)
				.backend(
					MAIL_CHECK_ID,
					"caller",
					"the mail never arrived",
					`${invite.operationId} returned ${called.status} and no out-of-band token followed.`,
					[called],
				)
		} else {
			const before = await invalidatedRead(input, accept, token, headers)
			const round = await consume(input, accept, token, headers, password)
			const last = round.exchanges.at(-1)
			const after = await invalidatedRead(input, accept, token, headers)
			const changed =
				last !== undefined &&
				last.status >= 200 &&
				last.status < 300 &&
				after !== null &&
				after.status >= 200 &&
				after.status < 300 &&
				(before === null || JSON.stringify(before.responseBody) !== JSON.stringify(after.responseBody))
			if (!changed) {
				input.findings
					.attributed([accept.operationId])
					.ownedBy(MAIL_CHECK_ID)
					.backend(
						MAIL_CHECK_ID,
						"caller",
						"the follow-up did not show the mailed change",
						`${accept.operationId} did not change the invite list.`,
						[called, ...round.exchanges],
					)
			}
		}
		input.grades.graded([accept.operationId], MAIL_CHECK_ID)
	}
	if (input.mode === "full" || input.inScope(invite.operationId))
		input.grades.graded([invite.operationId], MAIL_CHECK_ID)
}

async function resendCollaborator(
	input: MailInput,
	resend: OperationModel,
	roots: Record<string, string>,
	email: string,
): Promise<boolean> {
	const list = input.model.operations.find(
		(op) => op.method === "GET" && op.pathParams.includes("project_id") && op.path.includes("members"),
	)
	if (list === undefined) return false
	let listPath: string
	try {
		listPath = fillPath(list.path, roots)
	} catch {
		return false
	}
	const before = await input.client.request(list.method, listPath, {
		headers: input.auth,
		operationId: list.operationId,
	})
	const row = rowsOf(before.responseBody).find((item) => item.invite_email === email || item.email === email)
	if (row === undefined || typeof row.id !== "string") return false
	let resendPath: string
	try {
		resendPath = fillPath(resend.path, { ...roots, member_id: row.id })
	} catch {
		return false
	}
	const called = await postSender(input, resend, { invite_email: email }, input.auth, resendPath)
	if (called.status < 200 || called.status >= 300) return false
	const after = await input.client.request(list.method, listPath, {
		headers: input.auth,
		operationId: list.operationId,
	})
	const next = rowsOf(after.responseBody).find((item) => item.id === row.id)
	return next !== undefined && JSON.stringify(next) !== JSON.stringify(row)
}

async function runDeclineScene(input: MailInput): Promise<void> {
	const decline = input.model.operations.find((op) => op.method === "POST" && op.path.endsWith("/decline"))
	if (decline === undefined || (input.mode === "targeted" && !input.inScope(decline.operationId))) return
	const invite = input.model.operations.find(
		(op) => op.method === "POST" && op.invite !== null && op.pathParams.includes("organization_id"),
	)
	const ids = [decline.operationId]
	const blame = input.findings.attributed(ids).ownedBy(MAIL_CHECK_ID)
	if (invite?.invite == null) {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the invite was not sent",
			`${decline.operationId} had no invite to decline.`,
			[],
		)
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	let invitePath: string
	try {
		invitePath = fillPath(invite.path, input.roots ?? {})
	} catch {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the invite had no project",
			`${decline.operationId} had no organization id.`,
			[],
		)
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	const { email, headers } = await mailedAccount(input, "decline")
	if (headers === null) {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the mail account could not be opened",
			`${decline.operationId} had no account.`,
			[],
		)
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	const sent = await senderBody(input, invite, email, email)
	const grantee = invite.invite.granteeField
	if (grantee in propertyBag(requestSchemaOf(invite, input.model))) sent[grantee] = email
	const called = await postSender(input, invite, sent, input.auth, invitePath)
	if (called.status < 200 || called.status >= 300) {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the invite was not sent",
			`${invite.operationId} returned ${called.status}.`,
			[called],
		)
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	const list = invalidatedRead(input, decline, "", headers)
	const before = await list
	const row = rowsOf(before?.responseBody).find((item) => item.invite_email === email || item.email === email)
	if (before === null || row === undefined) {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the follow-up did not show the mailed change",
			`${decline.operationId} found no invite row.`,
			[called],
		)
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	const values: Record<string, string> = { ...(input.roots ?? {}) }
	for (const param of decline.pathParams) {
		const direct = row[param]
		if (typeof direct === "string" || typeof direct === "number") values[param] = String(direct)
		else if (param.endsWith("_id") && typeof row.id === "string") values[param] = row.id
	}
	const schema = requestSchemaOf(decline, input.model)
	const body: Record<string, unknown> = {}
	for (const name of Object.keys(propertyBag(schema))) {
		const value = row[name]
		if (typeof value === "string" || typeof value === "number") body[name] = value
	}
	let declinePath: string
	try {
		declinePath = fillPath(decline.path, values)
	} catch {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the invite was not sent",
			`${decline.operationId} could not fill its path.`,
			[called],
		)
		input.grades.graded(ids, MAIL_CHECK_ID)
		return
	}
	const declined = await input.client.request(decline.method, declinePath, {
		body,
		headers,
		operationId: decline.operationId,
	})
	const after = await invalidatedRead(input, decline, "", headers)
	const gone = rowsOf(after?.responseBody).every((item) => item.id !== row.id)
	if (declined.status < 200 || declined.status >= 300 || after === null || !gone) {
		blame.backend(
			MAIL_CHECK_ID,
			"caller",
			"the follow-up did not show the mailed change",
			`${decline.operationId} returned ${declined.status}.`,
			[called, declined],
		)
	}
	input.grades.graded(ids, MAIL_CHECK_ID)
}

function inPlay(input: MailInput, ops: OperationModel[]): string[] {
	return ops.filter((op) => input.mode === "full" || input.inScope(op.operationId)).map((op) => op.operationId)
}

async function mailedAccount(
	input: MailInput,
	label: string,
): Promise<{ email: string; headers: (() => Record<string, string>) | null; password: string }> {
	const flow = authFlowOf(input.authFlow)
	const domain = flow === null ? "example.test" : domainOf(signupEmail(flow))
	const password = flow === null ? "secret" : (signupPassword(flow) ?? "secret")
	const email = `oat-mail-${input.nonce ?? "user"}-${label}@${domain}`
	const headers = await openAccount(input, email, password)
	return { email, headers, password }
}
