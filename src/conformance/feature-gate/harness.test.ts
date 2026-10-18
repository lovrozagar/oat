import { describe, expect, it } from "vitest"
import type { Handle } from "../../reference/http/node.ts"
import { referenceRequest } from "../../reference/http/wire.ts"
import { featureGateHarness, gateBody, type HarnessOptions } from "./harness.ts"

const BEARER = { authorization: "Bearer tok_alpha" }

/** Sends one request to `handle` and reads the answer back as JSON. */
async function ask(
	handle: Handle,
	route: string,
	{ body, headers = BEARER }: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: unknown }> {
	const [method = "", path = ""] = route.split(" ")
	const answer = await handle(
		referenceRequest(method, new URL(path, "http://gate.test"), headers, async () => body ?? ""),
	)
	return { body: answer.body === "" ? undefined : JSON.parse(answer.body), status: answer.status }
}

const WEBHOOKS = "/v1/orgs/org_1/webhooks"
const created: HarnessOptions = { create: "created", specTag: null }

/** Webhook create against a fresh harness in `mode`. */
const create = async (mode: HarnessOptions["create"]) =>
	ask(featureGateHarness({ create: mode, specTag: null }), `POST ${WEBHOOKS}`, { body: '{"url":"u"}' })

describe("gateBody", () => {
	it("names the webhooks feature, and any other by its key", () => {
		expect(gateBody("webhooks")).toMatchObject({ vars: { feature: "webhooks", feature_name: "Webhooks" } })
		expect(gateBody("custom_domain")).toMatchObject({ vars: { feature_name: "custom_domain", type: "feature_gate" } })
	})
})

describe("featureGateHarness", () => {
	it("serves its document without a token, and nothing else", async () => {
		const handle = featureGateHarness({ create: "created", specTag: "webhooks" })
		const spec = await ask(handle, "GET /v1/openapi/spec", { headers: {} })
		expect(spec.status).toBe(200)
		expect(JSON.stringify(spec.body)).toContain('"x-feature-gate":"webhooks"')
		expect(await ask(handle, `GET ${WEBHOOKS}`, { headers: {} })).toEqual({
			body: { error_key: "unauthorized" },
			status: 401,
		})
		expect((await ask(handle, `GET ${WEBHOOKS}`, { headers: { authorization: "Basic x" } })).status).toBe(401)
	})

	it("answers webhook create as its mode says", async () => {
		expect(await create("gate-match")).toEqual({ body: gateBody("webhooks"), status: 403 })
		expect(await create("gate-mismatch")).toEqual({ body: gateBody("custom_domain"), status: 403 })
		expect(await create("plain-403")).toEqual({ body: { error_key: "forbidden" }, status: 403 })
		expect(await create("created")).toEqual({ body: { id: "wh_1", url: "u" }, status: 201 })
	})

	it("creates, reads, lists and updates webhooks", async () => {
		const handle = featureGateHarness(created)
		expect(await ask(handle, `POST ${WEBHOOKS}`, { body: "{}" })).toEqual({
			body: { error_key: "required", vars: { field: "url" } },
			status: 400,
		})
		await ask(handle, `POST ${WEBHOOKS}`, { body: '{"url":"a"}' })
		expect(await ask(handle, `GET ${WEBHOOKS}/wh_1`)).toEqual({ body: { id: "wh_1", url: "a" }, status: 200 })
		expect(await ask(handle, `PATCH ${WEBHOOKS}/wh_1`, { body: '{"url":"b"}' })).toEqual({
			body: { id: "wh_1", url: "b" },
			status: 200,
		})
		expect(await ask(handle, `PATCH ${WEBHOOKS}/wh_1`)).toEqual({ body: { id: "wh_1", url: "b" }, status: 200 })
		expect(await ask(handle, `GET ${WEBHOOKS}`)).toEqual({
			body: { webhooks: [{ id: "wh_1", url: "b" }] },
			status: 200,
		})
	})

	it("answers 404 for an unknown webhook, route or method", async () => {
		const handle = featureGateHarness(created)
		const missing = { body: { error_key: "not_found" }, status: 404 }
		expect(await ask(handle, `GET ${WEBHOOKS}/wh_9`)).toEqual(missing)
		expect(await ask(handle, `PATCH ${WEBHOOKS}/wh_9`, { body: "{}" })).toEqual(missing)
		expect(await ask(handle, `DELETE ${WEBHOOKS}/wh_9`)).toEqual(missing)
		expect(await ask(handle, "GET /v1/orgs/org_2/webhooks")).toEqual(missing)
	})
})

describe("featureGateHarness edges", () => {
	it("gates update before it looks for the row", async () => {
		const handle = featureGateHarness({ ...created, update: "gate-match" })
		expect(await ask(handle, `PATCH ${WEBHOOKS}/%E0`)).toEqual({ body: gateBody("webhooks"), status: 403 })
	})

	it("seeds an existing webhook when asked", async () => {
		const handle = featureGateHarness({ ...created, listSeeded: true })
		expect((await ask(handle, `GET ${WEBHOOKS}/wh_existing`)).status).toBe(200)
	})

	it("creates and lists invites, counting ids across both tables", async () => {
		const handle = featureGateHarness(created)
		const invites = "/v1/orgs/org_1/invites"
		expect(await ask(handle, `POST ${invites}`)).toEqual({
			body: { error_key: "required", vars: { field: "email" } },
			status: 400,
		})
		await ask(handle, `POST ${WEBHOOKS}`, { body: '{"url":"a"}' })
		expect(await ask(handle, `POST ${invites}`, { body: '{"email":"e"}' })).toEqual({
			body: { email: "e", id: "inv_2" },
			status: 201,
		})
		expect(await ask(handle, `GET ${invites}`)).toEqual({
			body: { invites: [{ email: "e", id: "inv_2" }] },
			status: 200,
		})
	})

	it("answers a 500 for a body or id it cannot read", async () => {
		const handle = featureGateHarness(created)
		const internal = { body: { error_key: "internal" }, status: 500 }
		expect(await ask(handle, `POST ${WEBHOOKS}`, { body: "{" })).toEqual(internal)
		expect(await ask(handle, `GET ${WEBHOOKS}/%E0`)).toEqual(internal)
	})
})
