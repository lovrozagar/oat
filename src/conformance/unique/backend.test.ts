import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { inProcess, type Via } from "../harness/launch.ts"
import { against, conflict, type HarnessOptions, widgetBackend } from "./backend.ts"

const AUTH = { authorization: "Bearer tok_alpha" }
const WIDGETS = "/v1/orgs/org_1/widgets"

/** A request's body and headers: none, and the owner's token, unless given. */
interface Sent {
	body?: string
	headers?: Record<string, string>
}

/** A backend for `options`, and a way to send it one request and read the answer. */
function harness(options: HarnessOptions) {
	const { handle, posts } = widgetBackend(options)
	const send = async (method: string, path: string, { body = "", headers = AUTH }: Sent = {}) => {
		const response = await handle(
			referenceRequest(method, new URL(`http://unique.test${path}`), { headers, read: async () => body }),
		)
		return { body: response.body === "" ? undefined : (JSON.parse(response.body) as unknown), status: response.status }
	}
	return { posts, send }
}

/** The answer to a second create, after one named `a` with slug `s`. */
async function duplicate(options: HarnessOptions, second = '{"name":"a"}') {
	const { send } = harness(options)
	await send("POST", WIDGETS, { body: '{"name":"a","slug":"s"}' })
	return send("POST", WIDGETS, { body: second })
}

describe("widgetBackend", () => {
	it("serves its document without a token, and refuses everything else without one", async () => {
		const { send } = harness({ spec: {} })
		expect((await send("GET", "/v1/openapi/spec", { headers: {} })).status).toBe(200)
		expect(await send("GET", WIDGETS, { headers: {} })).toEqual({ body: { error_key: "unauthorized" }, status: 401 })
		expect((await send("GET", WIDGETS, { headers: { authorization: "Basic x" } })).status).toBe(401)
	})

	it("creates, lists, reads, updates and deletes a widget", async () => {
		const { posts, send } = harness({ listSeeded: true, spec: {} })
		const created = await send("POST", WIDGETS, {
			body: '{"name":"a","email":"a@x.test","slug":"a"}',
			headers: {
				...AUTH,
				"idempotency-key": "k1",
			},
		})
		expect(created).toEqual({ body: { email: "a@x.test", id: "w_1", name: "a", slug: "a" }, status: 201 })
		expect(posts[0]?.headers["idempotency-key"]).toBe("k1")
		expect((await send("GET", WIDGETS)).body).toEqual({
			widgets: [
				{ email: "seed@example.test", id: "w_existing", name: "Existing Widget", slug: "existing" },
				{ email: "a@x.test", id: "w_1", name: "a", slug: "a" },
			],
		})
		expect(
			(await send("PATCH", `${WIDGETS}/w_1`, { body: '{"name":"b","email":"b@x.test","slug":"b"}' })).body,
		).toEqual({
			email: "b@x.test",
			id: "w_1",
			name: "b",
			slug: "b",
		})
		expect((await send("PATCH", `${WIDGETS}/w_1`)).body).toMatchObject({ name: "b" })
		expect((await send("GET", `${WIDGETS}/w_1`)).status).toBe(200)
		expect(await send("DELETE", `${WIDGETS}/w_1`)).toEqual({ body: undefined, status: 204 })
		expect(await send("GET", `${WIDGETS}/w_1`)).toEqual({ body: { error_key: "not_found" }, status: 404 })
		expect((await send("PATCH", `${WIDGETS}/w_1`, { body: "{}" })).status).toBe(404)
	})

	it("fills what a create leaves out from the new id", async () => {
		const { send } = harness({ spec: { omitTag: true } })
		expect((await send("POST", WIDGETS)).body).toEqual({
			email: "w_1@example.test",
			id: "w_1",
			name: "w_1",
			slug: "w_1",
		})
	})

	it("finds nothing at any other route or method, and answers a body it cannot read with a 500", async () => {
		const { send } = harness({ spec: {} })
		expect((await send("PUT", `${WIDGETS}/w_1`)).status).toBe(404)
		expect((await send("GET", `${WIDGETS}/w_1/parts`)).status).toBe(404)
		expect((await send("GET", "/v1/elsewhere")).status).toBe(404)
		expect(await send("POST", WIDGETS, { body: "{" })).toEqual({ body: { error_key: "internal" }, status: 500 })
	})
})

describe("widgetBackend's duplicates", () => {
	it("refuses the first create when the seed is meant to conflict", async () => {
		const { send } = harness({ seedConflict: true, spec: {} })
		expect((await send("POST", WIDGETS, { body: '{"name":"a"}' })).status).toBe(409)
		expect((await send("POST", WIDGETS, { body: '{"name":"a"}' })).status).toBe(201)
	})

	it("answers a duplicate create the way the case asks", async () => {
		expect(await duplicate({ spec: {} })).toEqual({ body: { error_key: "conflict", status: 409 }, status: 409 })
		expect((await duplicate({ duplicate: "201", spec: {} })).status).toBe(201)
		expect(await duplicate({ duplicate: "402", spec: {} })).toEqual({
			body: { error_key: "payment_required" },
			status: 402,
		})
		expect(await duplicate({ duplicate: "409-drift", spec: {} })).toEqual({ body: { oops: true }, status: 409 })
		expect((await duplicate({ duplicate: "gate-403", spec: {} })).body).toEqual({
			error_key: "forbidden",
			vars: { feature: "widgets", type: "feature_gate" },
		})
		expect((await duplicate({ duplicate: "gate-403", spec: { featureGate: "beta" } })).body).toMatchObject({
			vars: { feature: "beta" },
		})
	})

	it("enforces no set when the tag is missing or malformed", async () => {
		expect((await duplicate({ spec: { omitTag: true } })).status).toBe(201)
		expect((await duplicate({ spec: { tag: { not: "an array" } } })).status).toBe(201)
	})

	it("refuses a per-set duplicate on name or email, and inserts one on any other set", async () => {
		const tag = [["name"], ["slug"]]
		expect((await duplicate({ duplicate: "per-set", spec: { tag } })).status).toBe(409)
		expect((await duplicate({ duplicate: "per-set", spec: { tag } }, '{"name":"b","slug":"s"}')).status).toBe(201)
	})

	it("refuses a colliding update unless the case applies it", async () => {
		for (const [updateDuplicate, status] of [
			[undefined, 409],
			["409", 409],
			["201", 200],
			["ok", 200],
		] as const) {
			const { send } = harness({ spec: {}, ...(updateDuplicate === undefined ? {} : { updateDuplicate }) })
			await send("POST", WIDGETS, { body: '{"name":"a"}' })
			await send("POST", WIDGETS, { body: '{"name":"b"}' })
			expect((await send("PATCH", `${WIDGETS}/w_2`, { body: '{"name":"a"}' })).status).toBe(status)
		}
	})
})

describe("conflict", () => {
	const rows = [{ email: "a@x", id: "w_1", name: "a", slug: "s" }]

	it("names the first set a row already holds, never the row being updated", () => {
		expect(conflict([["email"], ["name"]], rows, { values: { name: "a" } })).toEqual(["name"])
		expect(conflict([["name"]], rows, { id: "w_1", values: { name: "a" } })).toBeNull()
		expect(conflict([["name", "slug"]], rows, { values: { name: "a" } })).toBeNull()
	})
})

describe("against", () => {
	it("runs oat on the widget alone through the via, and closes what it hosted", async () => {
		let closed = false
		const via: Via = {
			...inProcess,
			host: async (handle) => ({ ...(await inProcess.host(handle)), close: async () => void (closed = true) }),
		}
		const { posts, result } = await against(via, { duplicate: "409", spec: {} })
		expect(result.entitiesTested).toEqual(["widget"])
		expect(posts.length).toBeGreaterThan(0)
		expect(closed).toBe(true)
	}, 60_000)
})
