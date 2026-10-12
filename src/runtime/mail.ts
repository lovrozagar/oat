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
import { isAbsentValue, pollWithBackoff, resolveBackoff } from "./poll.ts"
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
		if (!requiresToken(consumer, model)) continue
		if (isInviteAccept(model, consumer)) continue
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
	seed?: number
}): Promise<void> {
	if (input.hooks?.resolveOutOfBand === undefined) return
	const pairs = mailPairs(input.model).filter(
		(pair) =>
			input.mode === "full" || input.inScope(pair.sender.operationId) || input.inScope(pair.consumer.operationId),
	)
	if (pairs.length === 0) return
	const read = callerRead(input.model)
	const flow = authFlowOf(input.authFlow)
	const domain = flow === null ? "example.test" : domainOf(signupEmail(flow))
	const password = flow === null ? "secret" : (signupPassword(flow) ?? "secret")
	let sequence = 0
	for (const pair of pairs) {
		const ids = [pair.sender.operationId, pair.consumer.operationId]
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
		let called = await input.client.request(pair.sender.method, pair.sender.path, {
			...(Object.keys(sent).length === 0 ? {} : { body: sent }),
			...(headers === undefined ? {} : { headers }),
			operationId: pair.sender.operationId,
		})
		if (
			called.status === 403 &&
			errorKey(called.responseBody).includes("reauth") &&
			headers !== undefined &&
			flow !== null
		) {
			await reauth(input, headers, password)
			called = await input.client.request(pair.sender.method, pair.sender.path, {
				...(Object.keys(sent).length === 0 ? {} : { body: sent }),
				headers,
				operationId: pair.sender.operationId,
			})
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
			const round = await consume(input, pair.consumer, token, headers, password)
			consumed.push(...round)
			const lastRound = round.at(-1)
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
		const proved = await followUpShows(input, pair, last, token, before, headers, nextEmail, read)
		if (!proved) {
			blame.backend(
				MAIL_CHECK_ID,
				read?.entity ?? "caller",
				"the follow-up did not show the mailed change",
				`${pair.consumer.operationId} returned ${last.status}, and the follow-up read did not show this call.`,
				[called, ...consumed],
			)
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
		if (requiresToken(op, model)) continue
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
	const prefix = commonPrefix(sender, consumer)
	const segments = prefix.split("/").filter(Boolean).length
	if (segments < 3) return -1
	const extra = sender.split("/").filter(Boolean).length - segments
	return prefix.length * 100 - extra
}

function commonPrefix(left: string, right: string): string {
	const limit = Math.min(left.length, right.length)
	let index = 0
	while (index < limit && left[index] === right[index]) index++
	return left.slice(0, index)
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

function isInviteAccept(model: SpecModel, op: OperationModel): boolean {
	return model.operations.some((item) => item.invite?.accept === op.operationId)
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
): Promise<Exchange[]> {
	const schema = requestSchemaOf(op, input.model)
	const enums = enumFields(schema).filter((field) => field.name !== "token")
	const rounds = enums.length === 0 ? [undefined] : enums.flatMap((field) => field.values)
	const exchanges: Exchange[] = []
	for (const value of rounds) {
		const body = generatedBody(schema, input.seed ?? 1, op.operationId)
		if (requiresToken(op, input.model) && "token" in propertyBag(schema)) body.token = token
		if ("password" in propertyBag(schema)) body.password = `${password}2`
		if (enums.length > 0 && value !== undefined) {
			for (const field of enums) body[field.name] = value
		}
		const query = queryToken(op, input.model) ? { token } : undefined
		let path = op.path
		try {
			path = fillPath(op.path, {})
		} catch {
			return exchanges
		}
		exchanges.push(
			await input.client.request(op.method, path, {
				...(Object.keys(body).length === 0 ? {} : { body }),
				...(query === undefined ? {} : { query }),
				...(headers === undefined ? {} : { headers }),
				operationId: op.operationId,
			}),
		)
	}
	return exchanges
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
): Promise<boolean> {
	const access = stringField(last.responseBody, "access_token")
	if (access !== null && read !== undefined) {
		const profile = await input.client.request(read.method, read.path, {
			headers: { authorization: `Bearer ${access}` },
			operationId: read.operationId,
		})
		if (profile.status !== 200) return false
		if ("new_email" in propertyBag(requestSchemaOf(pair.sender, input.model))) {
			return JSON.stringify(profile.responseBody).includes(nextEmail)
		}
		/* A session alone does not prove a write that claims to change the caller read. */
		if (pair.consumer.invalidates.includes(`${read.method} ${read.path}`)) {
			if (before === null || before.status < 200 || before.status >= 300) return false
			const after = await invalidatedRead(input, pair.consumer, token, headers)
			if (after === null || after.status < 200 || after.status >= 300) return false
			return JSON.stringify(before.responseBody) !== JSON.stringify(after.responseBody)
		}
		return true
	}
	const after = await invalidatedRead(input, pair.consumer, token, headers)
	if (after === null || after.status < 200 || after.status >= 300) return false
	if (before === null) return true
	return before.status !== after.status || JSON.stringify(before.responseBody) !== JSON.stringify(after.responseBody)
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
	const target = input.model.operations.find(
		(item) => item.method === "GET" && (item.path === path || item.route === named),
	)
	const query = target !== undefined && queryToken(target, input.model) ? { token } : undefined
	return input.client.request("GET", path, {
		...(query === undefined ? {} : { query }),
		...(headers === undefined ? {} : { headers }),
		...(target === undefined ? {} : { operationId: target.operationId }),
	})
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

async function peekMail(
	input: { hooks?: Hooks },
	address: string,
	kind: string,
): Promise<string | null> {
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

function tokenRejected(exchange: Exchange): boolean {
	if (exchange.status < 400 || exchange.status >= 500) return false
	const key = errorKey(exchange.responseBody)
	return key.includes("token") || key.includes("code") || key.includes("expired")
}
