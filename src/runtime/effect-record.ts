/**
 * A call whose proof is not in the response. The hook returns this run's records, written
 * by the server after it accepted the effect. The call passes when one of those records
 * contains the path values this call sent, and was written during the call.
 */

import type { AuthFlow, Hooks, PrincipalAuth } from "../config/define-config.ts"
import type { Client, Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { GradeLedger } from "./scope.ts"
import type { BackoffConfig } from "./poll.ts"
import { isAbsentValue, pollWithBackoff, resolveBackoff } from "./poll.ts"
import { fillPath } from "./world.ts"

export const EFFECT_CHECK_ID = "effect.record-shows-the-call"

export async function runEffectRecords(input: {
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
}): Promise<void> {
	if (input.hooks?.resolveOutOfBand === undefined || input.hooks.resolveRunRecord === undefined) return
	const ops = input.model.operations.filter(
		(op) => hasEffectRecord(input.model, op) && (input.mode === "full" || input.inScope(op.operationId)),
	)
	if (ops.length === 0) return
	const flow = authFlowOf(input.authFlow)
	const domain = flow === null ? "example.test" : domainOf(signupEmail(flow))
	const email = `oat-mail-${input.nonce ?? "user"}-effect@${domain}`
	for (const op of ops) {
		const ids = [op.operationId]
		const blame = input.findings.attributed(ids).ownedBy(EFFECT_CHECK_ID)
		const hint = op.operationId.replaceAll(".", " ")
		const link = await mailed(input, email, hint)
		const params = link === null ? null : paramsFromLink(op.path, link)
		if (link === null || params === null) {
			blame.backend(
				EFFECT_CHECK_ID,
				op.entity ?? "caller",
				"the effect link never arrived",
				`${op.operationId} had no mailed url that fills ${op.path}.`,
				[],
			)
			input.grades.graded(ids, EFFECT_CHECK_ID)
			continue
		}
		let path = op.path
		try {
			path = fillPath(op.path, params)
		} catch {
			blame.backend(
				EFFECT_CHECK_ID,
				op.entity ?? "caller",
				"the effect link never arrived",
				`${op.operationId} could not fill ${op.path}.`,
				[],
			)
			input.grades.graded(ids, EFFECT_CHECK_ID)
			continue
		}
		const called = await input.client.request(op.method, path, {
			headers: {},
			operationId: op.operationId,
		})
		const record = await recordOf(input)
		if (!recordShows(record, op.path, params, called)) {
			blame.backend(
				EFFECT_CHECK_ID,
				op.entity ?? "caller",
				"the run record did not show this call",
				`${op.operationId} returned ${called.status}, and this run's record did not contain the path from this call.`,
				[called],
			)
		}
		input.grades.graded(ids, EFFECT_CHECK_ID)
	}
}

function hasEffectRecord(model: SpecModel, op: OperationModel): boolean {
	const raw = model.rawOperations.get(op.operationId) as { "x-effect-record"?: unknown } | undefined
	return raw?.["x-effect-record"] === true
}

function paramsFromLink(template: string, link: string): Record<string, string> | null {
	let pathname: string
	try {
		pathname = new URL(link).pathname
	} catch {
		return null
	}
	const linkParts = pathname.split("/").filter(Boolean)
	const templateParts = template.split("/").filter(Boolean)
	if (linkParts.length < templateParts.length) return null
	const start = linkParts.length - templateParts.length
	const params: Record<string, string> = {}
	for (let index = 0; index < templateParts.length; index++) {
		const expected = templateParts[index]
		const got = linkParts[start + index]
		if (expected === undefined || got === undefined) return null
		if (expected.startsWith("{") && expected.endsWith("}")) {
			params[expected.slice(1, -1)] = decodePart(got)
			continue
		}
		if (expected !== got) return null
	}
	return params
}

function decodePart(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

function recordShows(body: unknown, template: string, params: Record<string, string>, called: Exchange): boolean {
	const statics = template.split("/").filter((part) => part !== "" && !part.startsWith("{"))
	const start = called.at - called.durationMs - 1_000
	return itemsOf(body).some((item) => {
		if (item === null || typeof item !== "object") return false
		const record = item as { at?: unknown; path?: unknown }
		if (typeof record.at !== "number" || typeof record.path !== "string") return false
		if (record.at < start || record.at > called.at + 5_000) return false
		const parts = record.path.split("/").filter(Boolean).map(decodePart)
		if (!statics.every((part) => parts.includes(part))) return false
		return Object.values(params).every((value) => parts.includes(value))
	})
}

function itemsOf(body: unknown): unknown[] {
	if (Array.isArray(body)) return body
	if (body !== null && typeof body === "object" && Array.isArray((body as { records?: unknown }).records)) {
		return (body as { records: unknown[] }).records
	}
	return []
}

async function mailed(
	input: { hooks?: Hooks; outOfBand?: Partial<BackoffConfig> },
	address: string,
	kind: string,
): Promise<string | null> {
	if (input.hooks?.resolveOutOfBand === undefined) return null
	try {
		const value = await pollWithBackoff(
			(attempt) =>
				input.hooks?.resolveOutOfBand?.({ address, attempt, headers: {}, kind, scope: {} }) ?? Promise.resolve(null),
			resolveBackoff(input.outOfBand),
			(item) => isAbsentValue(item),
		)
		return typeof value === "string" && value !== "" ? value : null
	} catch {
		return null
	}
}

async function recordOf(input: { hooks?: Hooks; outOfBand?: Partial<BackoffConfig> }): Promise<unknown> {
	if (input.hooks?.resolveRunRecord === undefined) return null
	try {
		return await pollWithBackoff(
			() => input.hooks?.resolveRunRecord?.() ?? Promise.resolve(null),
			resolveBackoff(input.outOfBand),
			(item) => isAbsentValue(item) || itemsOf(item).length === 0,
		)
	} catch {
		return null
	}
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

function domainOf(email: string | undefined): string {
	if (email === undefined) return "example.test"
	const at = email.lastIndexOf("@")
	return at > 0 ? email.slice(at + 1) : "example.test"
}
