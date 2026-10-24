/*
 * Swagger Petstore v3, the public demo: a manual target, run by hand and never by `test:targets`.
 * Written with `oat init`, then filled in. The demo accepts any key and any token, so the values
 * only need to be set; it is shared by everyone, so oat goes gently.
 *
 *   OAT_PETSTORE_AUTH_TOKEN=demo OAT_PETSTORE_API_KEY=special-key \
 *     oat run --config tests/targets/hosted/petstore/oat.config.ts
 */
import { defineConfig, env } from "../../../../src/index.ts"

export default defineConfig({
	spec: "https://petstore3.swagger.io/api/v3/openapi.json",
	baseUrl: "https://petstore3.swagger.io/api/v3",
	maxRps: 2,
	security: {
		// oauth2 implicit, sent as Authorization: Bearer; oat performs only clientCredentials and password grants
		petstore_auth: { holds: ["read:pets", "write:pets"], static: env("OAT_PETSTORE_AUTH_TOKEN") },
		// apiKey in header api_key; the demo documents "special-key"
		api_key: { static: env("OAT_PETSTORE_API_KEY") },
	},
	principals: {
		alpha: {},
	},
})
