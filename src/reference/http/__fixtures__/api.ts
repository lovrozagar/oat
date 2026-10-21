/** The reference in process: requests handed straight to its router, answers parsed back. */

import { issueSession } from "../auth/sessions.ts"
import { memoryStore } from "../engines.ts"
import { referenceState } from "../reference.ts"
import { handle } from "../router.ts"
import type { ReferenceOptions, ReferenceState } from "../state.ts"
import { type Json, referenceRequest } from "../wire.ts"

export type { Json }

/* Who a call acts as, by principal key: each is signed in once, and its access token sent as a bearer JWT. */
export const ALPHA = "key_alpha"
export const BETA = "key_beta"
export const MEMBER = "key_alpha_member"
export const VIEWER = "key_alpha_viewer"

export const TABLES = "/v1/projects/proj_alpha/tables"
export const BETA_TABLES = "/v1/projects/proj_beta/tables"
export const JOBS = "/v1/projects/proj_alpha/jobs"

export interface Sent {
	/** `null` sends no credential; a principal key sends its access token; any other text is sent as the bearer value. */
	token?: string | null
	/** Sent as JSON, or as the raw text when a string. */
	body?: unknown
	/** A form-encoded body. */
	form?: string
	headers?: Record<string, string>
}

export interface Answer {
	status: number
	headers: Record<string, string>
	body: Json
	/** The body, when it is an array. */
	items: Json[]
}

export interface Api {
	state: ReferenceState
	call: (method: string, path: string, sent?: Sent) => Promise<Answer>
	/** Creates a table as `token` and answers its record. */
	table: (name: string, token?: string) => Promise<Json>
}

export async function api(options: ReferenceOptions = {}): Promise<Api> {
	const state = await referenceState(options, memoryStore)
	const call = caller(state)
	const table = async (name: string, token = ALPHA): Promise<Json> => {
		const project = token === BETA ? "proj_beta" : "proj_alpha"
		return (await call("POST", `/v1/projects/${project}/tables`, { body: { name }, token })).body
	}
	return { call, state, table }
}

/* The access token a principal key signs in to, issued once per reference; any other text as itself. */
function bearerOf(state: ReferenceState, sessions: Map<string, string>, token: string): string {
	const account = state.auth.accounts.get(token)
	if (account === undefined) return token
	const issued = sessions.get(token) ?? issueSession(state, account).access_token
	sessions.set(token, issued)
	return issued
}

/* Sends one request to this reference's router, as `token` (the owner's by default), and parses the answer. */
function caller(state: ReferenceState): Api["call"] {
	const sessions = new Map<string, string>()
	return async (method, path, sent = {}) => {
		const headers: Record<string, string> = {}
		if (sent.token !== null) headers.authorization = `Bearer ${bearerOf(state, sessions, sent.token ?? ALPHA)}`
		let text = ""
		if (sent.form !== undefined) {
			headers["content-type"] = "application/x-www-form-urlencoded"
			text = sent.form
		} else if (sent.body !== undefined) {
			headers["content-type"] = "application/json"
			text = typeof sent.body === "string" ? sent.body : JSON.stringify(sent.body)
		}
		Object.assign(headers, sent.headers)
		const url = new URL(path, "http://reference.test")
		const answer = await handle(state, referenceRequest(method, url, { headers, read: async () => text }))
		const parsed = JSON.parse(answer.body) as unknown
		return {
			body: parsed as Json,
			headers: answer.headers,
			items: Array.isArray(parsed) ? (parsed as Json[]) : [],
			status: answer.status,
		}
	}
}

/** The rows path under one of alpha's tables. */
export function rowsOf(tableId: unknown, project = "proj_alpha"): string {
	return `/v1/projects/${project}/tables/${String(tableId)}/rows`
}
