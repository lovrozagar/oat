/**
 * Platform-admin routes. The hook grants the caller, oat refreshes so the new credential
 * carries that grant, and each route passes only when a later read shows this run's user.
 * Impersonation is ended before any later admin call, and its token is never adopted.
 */

import type { Hooks, PrincipalAuth } from "../config/define-config.ts"
import type { Client, Exchange } from "./client.ts"
import type { FindingCollector } from "./finding.ts"
import type { OperationModel, SpecModel } from "../spec/graph.ts"
import type { GradeLedger } from "./scope.ts"
import { fillPath } from "./world.ts"

export const ADMIN_CHECK_ID = "admin.caller-shows-in-the-read"

const SUPPORT_REASON = "spec tester support"

export async function runPlatformAdmin(input: {
	auth: () => Record<string, string>
	refresh?: (force?: boolean) => Promise<void>
	authFlow?: PrincipalAuth
	other?: { auth: () => Record<string, string>; flow?: PrincipalAuth }
	client: Client
	findings: FindingCollector
	grades: GradeLedger
	hooks?: Hooks
	inScope: (operationId: string) => boolean
	mode: "full" | "targeted"
	model: SpecModel
	roots?: Record<string, string>
}): Promise<void> {
	const admins = input.model.operations.filter(
		(op) => hasAdmin(input.model, op) && (input.mode === "full" || input.inScope(op.operationId)),
	)
	if (admins.length === 0) return
	const ids = admins.map((op) => op.operationId)
	const blame = input.findings.attributed(ids).ownedBy(ADMIN_CHECK_ID)
	const targetEmail = signupEmail(input.other?.flow) ?? signupEmail(input.authFlow)
	if (targetEmail === undefined || !targetEmail.includes("@")) {
		blame.backend(ADMIN_CHECK_ID, "caller", "the admin target was missing", "No signup address to search for.", [])
		input.grades.graded(ids, ADMIN_CHECK_ID)
		return
	}
	if (input.hooks?.preparePlatformAdmin === undefined) {
		blame.backend(ADMIN_CHECK_ID, "caller", "the admin grant was missing", "No preparePlatformAdmin hook.", [])
		input.grades.graded(ids, ADMIN_CHECK_ID)
		return
	}
	const granted = await input.hooks.preparePlatformAdmin({ headers: input.auth() })
	if (!granted) {
		blame.backend(ADMIN_CHECK_ID, "caller", "the admin grant was refused", "preparePlatformAdmin returned false.", [])
		input.grades.graded(ids, ADMIN_CHECK_ID)
		return
	}
	if (input.refresh !== undefined) await input.refresh(true)

	const profile = await ensureProfile(input, targetEmail)
	const search = admins.find((op) => op.method === "GET" && op.queryParamNames.includes("q"))
	const userGet = admins.find((op) => op.method === "GET" && /\/users\/\{[^}]+\}$/.test(op.path))
	const profileGet = admins.find((op) => op.method === "GET" && op.path.includes("public-profile"))
	const orgGet = admins.find((op) => op.method === "GET" && op.path.includes("/organizations/"))
	const start = admins.find((op) => op.method === "POST" && op.path.endsWith("/impersonations"))
	const end = admins.find((op) => op.method === "POST" && op.path.includes("/end"))
	const hide = admins.find((op) => op.method === "POST" && op.path.includes("/hide"))
	const unhide = admins.find((op) => op.method === "POST" && op.path.includes("/unhide"))
	const organizationId = input.roots?.organization_id

	let userId = profile.userId
	if (search !== undefined) {
		const found = await input.client.request(search.method, search.path, {
			headers: input.auth,
			operationId: search.operationId,
			query: { q: targetEmail },
		})
		if (!bodyHas(found, targetEmail)) {
			fail(input, search, "the search did not show the user", found)
		} else {
			input.grades.graded([search.operationId], ADMIN_CHECK_ID)
			userId = idForEmail(found.responseBody, targetEmail) ?? userId
		}
	}
	if (userGet !== undefined && userId !== undefined) {
		const read = await getId(input, userGet, userId)
		if (!bodyHas(read, targetEmail)) fail(input, userGet, "the user read did not show the user", read)
		else input.grades.graded([userGet.operationId], ADMIN_CHECK_ID)
	}
	if (orgGet !== undefined && organizationId !== undefined) {
		const read = await getId(input, orgGet, organizationId)
		if (!bodyHas(read, organizationId)) fail(input, orgGet, "the organization read did not show the organization", read)
		else input.grades.graded([orgGet.operationId], ADMIN_CHECK_ID)
	}
	let profileId = profile.profileId
	let handle = profile.handle
	if (profileGet !== undefined && userId !== undefined) {
		const read = await getId(input, profileGet, userId)
		const readHandle = stringField(read.responseBody, "handle")
		const readId = stringField(read.responseBody, "id")
		if (read.status < 200 || read.status >= 300 || (readHandle === null && readId === null)) {
			fail(input, profileGet, "the profile read did not show the user", read)
		} else {
			input.grades.graded([profileGet.operationId], ADMIN_CHECK_ID)
			profileId = readId ?? profileId
			handle = readHandle ?? handle
		}
	}

	/* End before hide or any other later admin call. Never adopt the impersonation token. */
	let impersonationId: string | undefined
	if (start !== undefined && userId !== undefined) {
		const started = await input.client.request(start.method, start.path, {
			body: { reason: SUPPORT_REASON, user_id: userId },
			headers: input.auth,
			operationId: start.operationId,
		})
		impersonationId = stringField(started.responseBody, "impersonation_id") ?? undefined
		if (!bodyHas(started, targetEmail) || impersonationId === undefined) {
			fail(input, start, "impersonation did not name the user", started)
		} else {
			input.grades.graded([start.operationId], ADMIN_CHECK_ID)
		}
	}
	if (end !== undefined && impersonationId !== undefined && userGet !== undefined) {
		const ended = await postId(input, end, impersonationId)
		const after = await getId(input, userGet, userId ?? "")
		if (ended.status < 200 || ended.status >= 300 || !impersonationEnded(after.responseBody, impersonationId)) {
			fail(input, end, "the user read did not show the impersonation ended", ended, after)
		} else {
			input.grades.graded([end.operationId], ADMIN_CHECK_ID)
		}
	}

	const page = input.model.operations.find((op) => op.method === "GET" && op.path.includes("/public-profiles/{"))
	if (hide !== undefined && profileId !== undefined && handle !== undefined && page !== undefined) {
		const hidden = await postId(input, hide, profileId)
		const absent = await input.client.request(page.method, fillPath(page.path, { handle }), {
			headers: {},
			operationId: page.operationId,
		})
		if (hidden.status < 200 || hidden.status >= 300 || absent.status < 400) {
			fail(input, hide, "the public profile still showed after hide", hidden, absent)
		} else {
			input.grades.graded([hide.operationId], ADMIN_CHECK_ID)
		}
	}
	if (unhide !== undefined && profileId !== undefined && handle !== undefined && page !== undefined) {
		const restored = await postId(input, unhide, profileId)
		const present = await input.client.request(page.method, fillPath(page.path, { handle }), {
			headers: {},
			operationId: page.operationId,
		})
		if (restored.status < 200 || restored.status >= 300 || !bodyHas(present, handle)) {
			fail(input, unhide, "the public profile did not show after unhide", restored, present)
		} else {
			input.grades.graded([unhide.operationId], ADMIN_CHECK_ID)
		}
	}

	for (const op of admins) {
		if (!input.grades.ran.get(op.operationId)?.has(ADMIN_CHECK_ID)) {
			fail(input, op, "the admin read was not prepared", undefined)
		}
	}
}

async function ensureProfile(
	input: { client: Client; model: SpecModel; other?: { auth: () => Record<string, string> } },
	email: string,
): Promise<{ handle?: string; profileId?: string; userId?: string }> {
	const headers = input.other?.auth
	if (headers === undefined) return {}
	const create = input.model.operations.find((op) => op.method === "POST" && op.path.endsWith("/public-profiles/me"))
	const read = input.model.operations.find((op) => op.method === "GET" && op.path.endsWith("/public-profiles/me"))
	const handle = handleFrom(email)
	if (create !== undefined) {
		const created = await input.client.request(create.method, create.path, {
			body: { display_name: "Oat", handle, is_public: true },
			headers,
			operationId: create.operationId,
		})
		if (created.status >= 200 && created.status < 300) return profileOf(created.responseBody, handle)
	}
	if (read === undefined) return { handle }
	const current = await input.client.request(read.method, read.path, { headers, operationId: read.operationId })
	return profileOf(current.responseBody, handle)
}

function profileOf(body: unknown, fallback: string): { handle?: string; profileId?: string } {
	const handle = stringField(body, "handle") ?? fallback
	const profileId = stringField(body, "id")
	return profileId === null ? { handle } : { handle, profileId }
}

async function getId(
	input: { auth: () => Record<string, string>; client: Client },
	op: OperationModel,
	id: string,
): Promise<Exchange> {
	return input.client.request(op.method, fillPath(op.path, { id }), {
		headers: input.auth,
		operationId: op.operationId,
	})
}

async function postId(
	input: { auth: () => Record<string, string>; client: Client },
	op: OperationModel,
	id: string,
): Promise<Exchange> {
	return input.client.request(op.method, fillPath(op.path, { id }), {
		headers: input.auth,
		operationId: op.operationId,
	})
}

function fail(
	input: { findings: FindingCollector; grades: GradeLedger },
	op: OperationModel,
	title: string,
	...exchanges: Array<Exchange | undefined>
): void {
	input.findings
		.attributed([op.operationId])
		.ownedBy(ADMIN_CHECK_ID)
		.backend(
			ADMIN_CHECK_ID,
			op.entity ?? "caller",
			title,
			`${op.operationId} did not show this run's user.`,
			exchanges.filter((item): item is Exchange => item !== undefined),
		)
	input.grades.graded([op.operationId], ADMIN_CHECK_ID)
}

function hasAdmin(model: SpecModel, op: OperationModel): boolean {
	const raw = model.rawOperations.get(op.operationId) as { "x-admin"?: unknown } | undefined
	return raw?.["x-admin"] === true
}

function bodyHas(exchange: Exchange, value: string): boolean {
	if (exchange.status < 200 || exchange.status >= 300) return false
	const body = exchange.responseBody
	const text = typeof body === "string" ? body : JSON.stringify(body ?? "")
	return text.includes(value)
}

function idForEmail(body: unknown, email: string): string | undefined {
	if (body === null || typeof body !== "object") return undefined
	if (Array.isArray(body)) {
		for (const item of body) {
			const found = idForEmail(item, email)
			if (found !== undefined) return found
		}
		return undefined
	}
	const record = body as Record<string, unknown>
	if (record.email === email && typeof record.id === "string" && record.id !== "") return record.id
	for (const child of Object.values(record)) {
		const found = idForEmail(child, email)
		if (found !== undefined) return found
	}
	return undefined
}

function impersonationEnded(body: unknown, id: string): boolean {
	const rows = findArray(body, "impersonations")
	return rows.some((row) => row.id === id && typeof row.ended_at === "number")
}

function findArray(body: unknown, key: string): Array<Record<string, unknown>> {
	if (body === null || typeof body !== "object") return []
	if (Array.isArray(body)) return body.flatMap((item) => findArray(item, key))
	const record = body as Record<string, unknown>
	const direct = record[key]
	const out: Array<Record<string, unknown>> = []
	if (Array.isArray(direct)) {
		for (const item of direct) {
			if (item !== null && typeof item === "object" && !Array.isArray(item)) out.push(item as Record<string, unknown>)
		}
	}
	for (const child of Object.values(record)) out.push(...findArray(child, key))
	return out
}

function stringField(body: unknown, key: string): string | null {
	if (body === null || typeof body !== "object" || Array.isArray(body)) return null
	const value = (body as Record<string, unknown>)[key]
	return typeof value === "string" && value !== "" ? value : null
}

function handleFrom(email: string): string {
	const raw =
		email
			.split("@")[0]
			?.toLowerCase()
			.replace(/[^a-z0-9]/g, "") ?? ""
	const handle = raw.slice(0, 20)
	return handle.length >= 3 ? handle : "oatprofile"
}

function signupEmail(auth: PrincipalAuth | undefined): string | undefined {
	if (auth === undefined || !("steps" in auth)) return undefined
	for (const step of auth.steps) {
		if (!("body" in step) || step.body === null || typeof step.body !== "object" || !("email" in step.body)) continue
		const email = (step.body as { email?: unknown }).email
		if (typeof email === "string") return email
	}
	return undefined
}
