import type { PrincipalsConfig, SecurityConfig } from "../../../config/types/security.ts"
import type { SpecModel } from "../../../spec/graph/types.ts"
import type { SecurityCredentials } from "../security.ts"
import { documentOf, modelOf } from "./models.ts"

/* The documents and configs the security facts and their text are tested on. */

/** A document modeled as doctor and plan model it. */
export const model = (doc: unknown): SpecModel => modelOf(doc).model

/** A config's credentials: `security`, read by `principals` (alpha alone by default). */
export const credentials = (
	security: SecurityConfig,
	principals: PrincipalsConfig = { alpha: {} },
): SecurityCredentials => ({ principals, security })

/** anyrow's config: a login for people, a static scoped key for machines. */
export const ANYROW = credentials({
	apiKey: { format: "ApiKey {credential}", holds: ["rows:read"], static: "k" },
	jwt: { login: { from: "$.access_token", steps: [{ operationId: "auth.login" }] } },
})

/** A bearer scheme and a legacy key, which two operations need alone. */
export const legacy = documentOf(
	{
		"/a": { get: { operationId: "a.get", responses: { "200": { description: "ok" } } } },
		"/b": { get: { operationId: "b.get", responses: { "200": { description: "ok" } }, security: [{ legacy: [] }] } },
		"/c": { get: { operationId: "c.get", responses: { "200": { description: "ok" } }, security: [{ legacy: [] }] } },
	},
	{
		components: {
			securitySchemes: {
				jwt: { scheme: "bearer", type: "http" },
				legacy: { in: "header", name: "X-Legacy", type: "apiKey" },
			},
		},
		security: [{ jwt: [] }],
	},
)
