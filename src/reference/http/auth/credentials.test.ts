import { describe, expect, it } from "vitest"
import { memoryStore } from "../engines.ts"
import { HttpError } from "../errors.ts"
import { referenceState } from "../reference.ts"
import { PRINCIPALS, type ReferenceOptions } from "../state.ts"
import { referenceRequest } from "../wire.ts"
import { createApiKey } from "./api-keys.ts"
import { authenticate } from "./credentials.ts"
import { issueSession } from "./sessions.ts"

const ALPHA = PRINCIPALS[0] as (typeof PRINCIPALS)[0]
const NEED = { projectId: "proj_alpha", scope: "table:read" }

const world = (options: ReferenceOptions = {}) => referenceState(options, memoryStore)

const request = (authorization?: string) =>
	referenceRequest("GET", new URL("http://reference.test/"), {
		headers: authorization === undefined ? {} : { authorization },
		read: async () => "",
	})

function refusal(run: () => unknown): { status: number; message: string } {
	try {
		run()
	} catch (error) {
		if (error instanceof HttpError) return { message: error.message, status: error.status }
	}
	throw new Error("no refusal")
}

describe("authenticate", () => {
	it("refuses a request with no credential, an empty one, or one of a scheme the server does not take", async () => {
		const state = await world()
		for (const header of [undefined, "", "Bearer", "Bearer   "]) {
			expect(refusal(() => authenticate(state, request(header)))).toEqual({
				message: "missing credential",
				status: 401,
			})
		}
		expect(refusal(() => authenticate(state, request("Basic YTpi")))).toEqual({
			message: "unsupported credential scheme",
			status: 401,
		})
	})

	it("authenticates a bearer JWT on any route, its scheme name in any case", async () => {
		const state = await world()
		const { access_token: token } = issueSession(state, ALPHA)
		expect(authenticate(state, request(`Bearer ${token}`)).key).toBe("key_alpha")
		expect(authenticate(state, request(`bearer ${token}`), NEED).key).toBe("key_alpha")
		expect(refusal(() => authenticate(state, request("Bearer tok_alpha"))).status).toBe(401)
	})

	it("authenticates an API key where the route takes one, and refuses it on a jwt-only route", async () => {
		const state = await world()
		const { value } = createApiKey(state, ALPHA, ["table:read"])
		expect(authenticate(state, request(`ApiKey ${value}`), NEED).key).toBe("key_alpha")
		expect(refusal(() => authenticate(state, request(`ApiKey ${value}`)))).toEqual({
			message: "this operation does not accept an API key",
			status: 401,
		})
	})

	it("lets an API key into a jwt-only route under ANY_SCHEME_ACCEPTED", async () => {
		const state = await world({ defects: ["ANY_SCHEME_ACCEPTED"] })
		const { value } = createApiKey(state, ALPHA, [])
		expect(authenticate(state, request(`ApiKey ${value}`)).key).toBe("key_alpha")
	})

	it("refuses every API key, where the route takes one, under APIKEY_ALTERNATIVE_BROKEN", async () => {
		const state = await world({ defects: ["APIKEY_ALTERNATIVE_BROKEN"] })
		const { value } = createApiKey(state, ALPHA, ["table:read"])
		expect(refusal(() => authenticate(state, request(`ApiKey ${value}`), NEED))).toEqual({
			message: "API keys are not accepted here",
			status: 401,
		})
	})
})
