import { harness, SECURITY } from "../../../../../credentials/__fixtures__/store.ts"
import type { SpecModel } from "../../../../../spec/graph/types.ts"
import type { OpenApiDocument } from "../../../../../spec/types.ts"
import { probeCredentials } from "../../../../run/probe-credentials.ts"
import type { RunContext } from "../../../../run/context.ts"
import { modelOf } from "../../../__fixtures__/harness.ts"
import { actorOf, operationContextFor, type SentResponder } from "./operation-context.ts"

/*
 * An operation check over the run's real credential store: the store fixture's `jwt` login and `key`
 * mint (with jwt, revoked by apiKey.revoke), behind counting fakes. A test shows every key a check
 * has the store mint is one `revokeAll` revokes, and that no check calls the mint itself.
 */

const ok = { "200": { description: "ok" } }

/** A document of the store fixture's schemes: `notes.list` takes jwt or a notes:read key, `me.read` jwt alone. */
export const KEYED: SpecModel = /* @__PURE__ */ modelOf({
	components: {
		securitySchemes: {
			jwt: { scheme: "bearer", type: "http" },
			key: { in: "header", name: "Authorization", type: "apiKey" },
		},
	},
	info: { title: "keys", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/me": { get: { operationId: "me.read", responses: ok, security: [{ jwt: [] }] } },
		"/notes": { get: { operationId: "notes.list", responses: ok, security: [{ jwt: [] }, { key: ["notes:read"] }] } },
	},
} as unknown as OpenApiDocument)

/** `operationId` of KEYED staged as principal ann, probing through the real store, answered by `respond`. */
export function keyedStage(operationId: string, respond: SentResponder) {
	const { mintCalls, recorded, store } = harness()
	const options = { security: SECURITY } as unknown as RunContext["options"]
	const stage = operationContextFor(KEYED, operationId, { principals: [actorOf("ann")], respond })
	const ctx = { ...stage.ctx, probe: probeCredentials({ model: KEYED, options, store }) }
	const revoked = () => recorded.calls.filter((call) => call.operationId === "apiKey.revoke")
	return { ctx, mintCalls, revoked, sent: stage.sent, store }
}
