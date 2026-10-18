import type { RequestOptions } from "../../../../client.ts"
import { type Answer, contextFor, modelOf, type Responder } from "../../../__fixtures__/harness.ts"
import type { CheckContext } from "../../../core/context.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import { actor } from "./context.ts"

/*
 * Notes an owner shares by invite: invite, accept and revoke operations around a readable note,
 * and a backend that keeps the grant's state. Options shape the document; switches on the backend
 * reproduce the defects the check exists for.
 */

export interface InviteDocOptions {
	/** The `x-invite` tag, over invite/accept/revoke defaults. */
	tag?: Record<string, unknown>
	invitePath?: string
	acceptPath?: string
	/** Request body schema of accept; absent means none. */
	acceptBody?: Record<string, unknown>
	/** Media type of accept's body; default JSON. */
	acceptMedia?: string
	revokePath?: string
	revokeMethod?: string
	revokeBody?: Record<string, unknown>
	/** Leave these operations out. */
	without?: readonly string[]
}

const NOTE = { properties: { id: { type: "string" }, title: { type: "string" } }, type: "object" }

function json(schema: unknown, media = "application/json"): Record<string, unknown> {
	return { content: { [media]: { schema } } }
}

function paramsOf(path: string): Array<Record<string, unknown>> {
	return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
		in: "path",
		name: match[1],
		required: true,
		schema: { type: "string" },
	}))
}

function operation(id: string, path: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { operationId: id, parameters: paramsOf(path), responses: { "200": { description: "ok" } }, ...extra }
}

export function inviteDocument(options: InviteDocOptions = {}): OpenApiDocument {
	const acceptPath = options.acceptPath ?? "/invites/{token}/accept"
	const revokePath = options.revokePath ?? "/orgs/{org_id}/notes/{note_id}/invites/{grant_id}"
	const invitePath = options.invitePath ?? "/orgs/{org_id}/notes/{note_id}/invites"
	const gate = { "x-feature-gate": "sharing" }
	const paths: Record<string, Record<string, unknown>> = {
		"/orgs/{org_id}/notes": {
			get: operation("listNotes", "/orgs/{org_id}/notes", {
				responses: { "200": { description: "notes", ...json({ items: NOTE, type: "array" }) } },
			}),
		},
		"/orgs/{org_id}/notes/{note_id}": {
			get: operation("readNote", "/orgs/{org_id}/notes/{note_id}", {
				responses: { "200": { description: "one", ...json(NOTE) } },
			}),
		},
		[invitePath]: {
			post: operation("inviteNote", invitePath, {
				...gate,
				requestBody: json({ properties: { key: { type: "string" } }, type: "object" }),
				"x-invite": { accept: "acceptInvite", invite: "inviteNote", revoke: "revokeInvite", ...options.tag },
			}),
		},
		"/orgs/{org_id}/shared": { get: operation("sharedNotes", "/orgs/{org_id}/shared") },
	}
	const accept = operation("acceptInvite", acceptPath, {
		...gate,
		...(options.acceptBody === undefined ? {} : { requestBody: json(options.acceptBody, options.acceptMedia) }),
	})
	const revoke = operation("revokeInvite", revokePath, {
		...gate,
		...(options.revokeBody === undefined ? {} : { requestBody: json(options.revokeBody) }),
	})
	paths[acceptPath] = { ...paths[acceptPath], post: accept }
	paths[revokePath] = { ...paths[revokePath], [options.revokeMethod ?? "delete"]: revoke }
	for (const [path, operations] of Object.entries(paths)) {
		for (const [method, op] of Object.entries(operations)) {
			if (options.without?.includes((op as { operationId: string }).operationId) === true) delete operations[method]
		}
		if (Object.keys(operations).length === 0) delete paths[path]
	}
	return { info: { title: "invites", version: "1" }, openapi: "3.1.0", paths } as OpenApiDocument
}

export interface InviteBackendOptions {
	/** The delegate can read as soon as it is invited. */
	grantsBeforeAccept?: boolean
	/** Accepting never opens the read. */
	neverGrants?: boolean
	/** Access survives revoke. */
	revokeIgnored?: boolean
	/** The delegate can read before anything happens. */
	alreadyShared?: boolean
	/** Answers that replace the backend's, by `METHOD path`. */
	override?: Record<string, Answer>
	/** The invite's answer body. */
	invited?: unknown
	/** The accept's answer body. */
	accepted?: unknown
}

/** A feature-gate refusal as the gated operations document it. */
export const GATED: Answer = { body: { vars: { feature: "sharing", type: "feature_gate" } }, status: 403 }

/** The backend, and who it lets read: the owner always, the delegate as the grant allows. */
export function inviteBackend(options: InviteBackendOptions = {}) {
	const state = { accepted: false, invited: false, revoked: false }
	const delegateMayRead = (): boolean => {
		if (options.alreadyShared === true) return true
		if (state.revoked && options.revokeIgnored !== true) return false
		if (options.grantsBeforeAccept === true && state.invited) return true
		return state.accepted && options.neverGrants !== true
	}
	const step = (method: string, path: string): Answer => {
		if (path.includes("accept")) {
			state.accepted = true
			return { body: options.accepted ?? {}, status: 200 }
		}
		if (method === "GET") return delegateMayRead() ? { body: { id: "n1" }, status: 200 } : { status: 404 }
		if (path.endsWith("/invites")) {
			state.invited = true
			return { body: options.invited ?? { grant_id: "g1", token: "t1" }, status: 201 }
		}
		state.revoked = true
		return { status: 204 }
	}
	return (method: string, path: string, _options: RequestOptions): Answer =>
		options.override?.[`${method} ${path}`] ?? step(method, path)
}

/** The owner in org o1; the delegate, invited as bob, in org o2. */
export const owner = actor("owner", 1, { org_id: "o1" })
export const delegate = actor("delegate", 1, { org_id: "o2" }, { inviteAs: "bob" })

/** A context on note n1 with the invite tag the document declares, as the owner. */
export function inviteContext(doc: OpenApiDocument, respond: Responder, fields: Partial<CheckContext> = {}) {
	const model = modelOf(doc)
	const invites = [...model.entities.values()].find((entity) => entity.invite !== null)
	return contextFor(model, "listNotes", respond, {
		actors: [owner, delegate],
		auth: owner.headers,
		invite: invites?.invite ?? null,
		readOp: model.byOperationId.get("readNote"),
		records: [{ id: "n1", title: "first" }],
		scope: { org_id: "o1" },
		...fields,
	})
}
