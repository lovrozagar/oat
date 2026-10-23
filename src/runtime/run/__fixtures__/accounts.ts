import type { OpenApiDocument } from "../../../spec/types.ts"
import type { Responder } from "../../checks/__fixtures__/harness.ts"
import { notesApi, notesDoc } from "./api.ts"

/*
 * An API that makes accounts and can remove them: a signup marked `x-fresh-principal`, the create of
 * `member` by its `member_id`, a login by email, the caller's own read and delete-self, and an admin
 * delete of a member by id. Each part can be left out or made to fail.
 */

const json = (schema: unknown) => ({ content: { "application/json": { schema } } })

const SIGNUP = {
	properties: { email: { format: "email", type: "string" }, password: { minLength: 8, type: "string" } },
	required: ["email", "password"],
	type: "object",
}

/** What the document holds beside the signup and login. */
export interface AccountsDoc {
	deleteSelf?: boolean
	adminDelete?: boolean
	/** The delete-self takes an API key, not the bearer token every other operation takes. */
	selfByApiKey?: boolean
	/** The delete-self takes no credential at all. */
	selfOpen?: boolean
}

export function accountsDoc(parts: AccountsDoc = {}): OpenApiDocument {
	const me: Record<string, unknown> = {
		get: {
			operationId: "me.read",
			responses: { "200": { description: "ok" } },
			"x-entity": { action: "read", identity: "self", name: "me" },
		},
	}
	if (parts.deleteSelf !== false) {
		me["delete"] = {
			operationId: "me.delete",
			responses: { "204": { description: "gone" } },
			"x-destructive": true,
			"x-entity": { action: "delete", identity: "self", name: "me" },
			...(parts.selfByApiKey === true ? { security: [{ apiKey: [] }] } : {}),
			...(parts.selfOpen === true ? { security: [] } : {}),
		}
	}
	const doc = notesDoc({
		"/login": { post: { operationId: "auth.login", responses: { "200": { description: "ok" } }, security: [] } },
		"/me": me,
		...(parts.adminDelete === true
			? {
					"/members/{member_id}": {
						delete: {
							operationId: "member.delete",
							parameters: [{ in: "path", name: "member_id", required: true, schema: { type: "string" } }],
							responses: { "204": { description: "gone" } },
							"x-entity": { action: "delete", identity: "member_id", name: "member" },
						},
					},
				}
			: {}),
		"/signup": {
			post: {
				operationId: "auth.signup",
				requestBody: { required: true, ...json(SIGNUP) },
				responses: { "201": { description: "made" } },
				security: [],
				"x-entity": { action: "create", identity: "member_id", name: "member" },
				"x-fresh-principal": true,
			},
		},
	})
	if (parts.selfByApiKey !== true) return doc
	const schemes = { ...doc.components?.securitySchemes, apiKey: { in: "header", name: "x-api-key", type: "apiKey" } }
	return { ...doc, components: { ...doc.components, securitySchemes: schemes } } as OpenApiDocument
}

/** The accounts the API holds, by the token each signs in with, and how its removals answer. */
export interface AccountsState {
	byToken: Map<string, string>
	removed: string[]
	/** What a delete-self answers; 204 by default. */
	selfStatus?: number
	/** What an admin delete answers; 204 by default. */
	adminStatus?: number
}

export function accountsState(): AccountsState {
	return { byToken: new Map(), removed: [] }
}

/* A login by email; one whose email starts `nologin` is refused. */
function login(email: string) {
	return email.startsWith("nologin") ? { status: 401 } : { body: { access_token: `login-${email}` }, status: 200 }
}

/* A signup: the account signs in as `t-<email>` or `login-<email>`; `quiet`, its answer names nothing. */
function signUp(state: AccountsState, email: string, quiet: boolean) {
	state.byToken.set(`t-${email}`, email)
	state.byToken.set(`login-${email}`, email)
	return quiet ? { status: 201 } : { body: { access_token: `t-${email}`, member_id: `m-${email}` }, status: 201 }
}

/** The API behind `doc`: a signup answers `t-<email>` and `m-<n>`; a login by email answers `login-<email>`. */
export function accountsApi(state: AccountsState, doc = accountsDoc()): Responder {
	const notes = notesApi(doc)
	return (method, path, request) => {
		const body = (request.body ?? {}) as Record<string, unknown>
		const headers = (request.headers ?? {}) as Record<string, string>
		const token = String(headers["authorization"] ?? "").replace(/^Bearer /, "")
		if (path === "/signup") return signUp(state, String(body["email"]), headers["x-quiet"] !== undefined)
		if (path === "/login") return login(String(body["email"]))
		const email = state.byToken.get(token)
		if (path === "/me" && method === "DELETE") {
			if (email === undefined) return { status: 401 }
			state.removed.push(email)
			return { status: state.selfStatus ?? 204 }
		}
		if (path === "/me") return email === undefined ? { status: 401 } : { body: { email }, status: 200 }
		if (path.startsWith("/members/") && method === "DELETE") {
			state.removed.push(decodeURIComponent(path.slice("/members/m-".length)))
			return { status: state.adminStatus ?? 204 }
		}
		return notes(method, path, request)
	}
}
