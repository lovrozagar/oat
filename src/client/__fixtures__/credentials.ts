/** A client over a real credential store with fake ports, for acceptance tests of what a request carries. */

import type { PrincipalsConfig, SecurityConfig } from "../../config/types/security.ts"
import { fakePorts } from "../../credentials/__fixtures__/ports.ts"
import type { CredentialPorts } from "../../credentials/ports.ts"
import { createStore } from "../../credentials/store.ts"
import { Redactor } from "../../security/redact.ts"
import { buildModel } from "../../spec/graph/build.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { Client } from "../client.ts"
import { createCredentialSource } from "../credentials.ts"
import type { ClientOptions, OperationResolver } from "../types.ts"
import { type Answer, transport } from "./transport.ts"

export const BASE = "http://api.test/v1"

const ok = { "200": { description: "ok" } }
const get = (operationId: string, security: Array<Record<string, string[]>>) => ({
	get: { operationId, responses: ok, security },
})

/** One scheme per place a credential goes, an operation for each, and one anonymous operation. */
export const placesDoc = {
	components: {
		securitySchemes: {
			hdr: { in: "header", name: "X-Key", type: "apiKey" },
			jwt: { scheme: "bearer", type: "http" },
			qry: { in: "query", name: "k", type: "apiKey" },
			sess: { in: "cookie", name: "sess", type: "apiKey" },
		},
	},
	info: { title: "places", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/all": get("all.get", [{ hdr: [], qry: [], sess: [] }]),
		"/h": get("h.get", [{ hdr: [] }]),
		"/me": get("me.get", [{ jwt: [] }]),
		"/open": get("open.get", []),
		"/q": get("q.get", [{ qry: [] }]),
	},
} as unknown as OpenApiDocument

/** Maps a path below the base to the operation the document puts there. */
export function resolverOf(doc: OpenApiDocument): OperationResolver {
	const model = buildModel(doc)
	return (method, path) => {
		const operation = model.byRoute.get(`${method} ${path}`)
		return operation === undefined ? null : { operationId: operation.operationId, template: path }
	}
}

export interface Setup {
	doc: OpenApiDocument
	security: SecurityConfig
	principals?: PrincipalsConfig
	answer: Answer
	ports?: CredentialPorts
	client?: Partial<ClientOptions>
}

/** A client whose credential source reads `doc` over a store holding `security` and `principals`. */
export function clientOf(setup: Setup) {
	const model = buildModel(setup.doc)
	const principals = setup.principals ?? { alpha: {} }
	const ports = setup.ports ?? fakePorts().ports
	const store = createStore({ ports, principals, schemes: model.schemes, security: setup.security })
	const wire = transport(setup.answer)
	const client = new Client({
		baseUrl: BASE,
		credentials: createCredentialSource({ model, principals, security: setup.security, store }),
		network: { fetchImpl: wire.fetch },
		operationResolver: resolverOf(setup.doc),
		redactor: new Redactor(),
		...setup.client,
	})
	return { client, sent: wire.sent }
}
