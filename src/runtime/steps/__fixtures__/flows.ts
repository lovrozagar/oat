import type { Hooks } from "../../../config/types/hooks.ts"
import type { OpenApiDocument } from "../../../spec/types.ts"
import { fakeClient, modelOf, type Responder, type Sent } from "../../checks/__fixtures__/harness.ts"
import type { StepContext } from "../request.ts"

/*
 * A socket-free stage for the step engine: a document with a form login, a JSON token exchange and
 * a path-scoped read, a second origin with its own document, and fake clients that record what
 * they were sent.
 */

const ok = { "200": { description: "ok" } }
const object = (properties: Record<string, unknown>) => ({ properties, type: "object" })

export const flowDoc = {
	info: { title: "flows", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/login": {
			post: {
				operationId: "auth.login",
				requestBody: {
					content: {
						"application/x-www-form-urlencoded": {
							encoding: { tags: { explode: false, style: "form" } },
							schema: object({ tags: { items: { type: "string" }, type: "array" }, user: { type: "string" } }),
						},
					},
				},
				responses: ok,
			},
		},
		"/orgs/{org}": {
			get: {
				operationId: "orgs.get",
				parameters: [{ in: "path", name: "org", required: true, schema: { type: "string" } }],
				responses: ok,
			},
		},
		"/ping": { get: { operationId: "ping", responses: ok } },
		"/token": {
			post: {
				operationId: "auth.token",
				requestBody: { content: { "application/json": { schema: object({ user: { type: "string" } }) } } },
				responses: ok,
			},
		},
	},
} as unknown as OpenApiDocument

export const ssoDoc = {
	info: { title: "sso", version: "1" },
	openapi: "3.1.0",
	paths: { "/start": { post: { operationId: "sso.start", responses: ok } } },
} as unknown as OpenApiDocument

/** A step context over `respond`, with an `sso` origin answered by `sso`, and what each was sent. */
export function stepStage(
	respond: Responder,
	fields: { hooks?: Hooks; sso?: Responder } = {},
): { ctx: StepContext; sent: Sent[]; ssoSent: Sent[] } {
	const primary = fakeClient(respond)
	const sso = fakeClient(fields.sso ?? (() => ({ status: 200 })))
	const ctx: StepContext = {
		client: primary.client,
		hooks: fields.hooks ?? {},
		model: modelOf(flowDoc),
		originClients: new Map([["sso", { client: sso.client, model: modelOf(ssoDoc) }]]),
		outOfBand: { attempts: 2, initialMs: 1, maxMs: 1 },
		principalId: "alice",
	}
	return { ctx, sent: primary.sent, ssoSent: sso.sent }
}
