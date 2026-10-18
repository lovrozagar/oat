import { type Responder, fakeClient, modelOf } from "../../checks/__fixtures__/harness.ts"
import { FindingCollector } from "../../finding.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import type { SelfInput } from "../identity.ts"

/*
 * The signed-up caller as an API serves it: `/me` to read and update, a create, a second read,
 * and a query action on the caller. Each part can be left out or reshaped.
 */

const json = (schema: unknown): { content: Record<string, { schema: unknown }> } => ({
	content: { "application/json": { schema } },
})

export const PROFILE = {
	properties: {
		display_name: { maxLength: 40, type: "string" },
		handle: { type: "string" },
		id: { readOnly: true, type: "string" },
	},
	type: "object",
}

const tag = (action: string): Record<string, unknown> => ({ "x-entity": { action, identity: "self", name: "profile" } })

export interface MeOptions {
	/** The read's path; `false` leaves the read out. */
	read?: string | false
	/** A second read, at this path. */
	secondRead?: string
	/** The update's body schema; `false` leaves the update out. */
	update?: unknown
	/** The update's path. */
	updatePath?: string
	/** The create's body schema; `false` leaves the create out, `null` keeps it without a body. */
	create?: unknown
	createPath?: string
	/** A GET action on the caller, with these query parameters. */
	action?: string[]
}

export function me(options: MeOptions = {}): OpenApiDocument {
	const paths: Record<string, Record<string, unknown>> = {}
	const add = (path: string, method: string, op: Record<string, unknown>): void => {
		const params = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
			in: "path",
			name: m[1],
			required: true,
			schema: { type: "string" },
		}))
		paths[path] = { ...paths[path], [method]: { ...(params.length === 0 ? {} : { parameters: params }), ...op } }
	}
	const ok = { "200": { ...json(PROFILE), description: "ok" } }
	if (options.read !== false)
		add(options.read ?? "/me", "get", { operationId: "me.get", responses: ok, ...tag("read") })
	if (options.secondRead !== undefined) {
		add(options.secondRead, "get", { operationId: "me.settings", responses: ok, ...tag("read") })
	}
	if (options.update !== false) {
		add(options.updatePath ?? "/me", "patch", {
			operationId: "me.update",
			requestBody: json(options.update ?? PROFILE),
			responses: ok,
			...tag("update"),
		})
	}
	if (options.create !== undefined && options.create !== false) {
		add(options.createPath ?? "/me", "post", {
			operationId: "me.create",
			...(options.create === null ? {} : { requestBody: json(options.create) }),
			responses: { "201": { ...json(PROFILE), description: "created" } },
			...tag("create"),
		})
	}
	if (options.action !== undefined) {
		add("/me/lookup", "get", {
			operationId: "me.lookup",
			parameters: options.action.map((name) => ({ in: "query", name, required: true, schema: { type: "string" } })),
			responses: ok,
			"x-entity": { action: "action", identity: "self", name: "profile" },
		})
	}
	return { info: { title: "me", version: "1" }, openapi: "3.1.0", paths } as unknown as OpenApiDocument
}

/** A self check's input over `document`, answered by `respond`, with what it sent and found. */
export function selfInput(respond: Responder, document: OpenApiDocument = me(), fields: Partial<SelfInput> = {}) {
	const model = modelOf(document)
	const fake = fakeClient(respond)
	const findings = new FindingCollector()
	const entity = model.entities.get("profile")
	if (entity === undefined) throw new Error("the document has no profile entity")
	const input: SelfInput = {
		auth: () => ({ authorization: "Bearer me" }),
		client: fake.client,
		entity,
		findings,
		model,
		...fields,
	}
	return { findings, input, model, sent: fake.sent }
}
