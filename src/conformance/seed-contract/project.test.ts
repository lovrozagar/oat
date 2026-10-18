import { describe, expect, it } from "vitest"
import { referenceRequest } from "../../reference/http/wire.ts"
import { projectBackend, projectSpec } from "./project.ts"

function ask(method: string, path: string, body = "") {
	return referenceRequest(method, new URL(path, "http://project.test"), { headers: {}, read: async () => body })
}

describe("projectBackend", () => {
	it("serves its spec, creates, lists and reads projects", async () => {
		const { handle } = projectBackend()
		expect(JSON.parse((await handle(ask("GET", "/v1/openapi/spec"))).body)).toEqual(projectSpec())
		expect(JSON.parse((await handle(ask("POST", "/v1/projects", '{"name":"alpha"}'))).body)).toEqual({
			id: "p_1",
			name: "alpha",
		})
		expect(JSON.parse((await handle(ask("POST", "/v1/projects"))).body)).toEqual({ id: "p_2", name: "n" })
		expect(JSON.parse((await handle(ask("GET", "/v1/projects"))).body).projects).toHaveLength(2)
		expect((await handle(ask("GET", "/v1/projects/p_1"))).status).toBe(200)
		expect((await handle(ask("GET", "/v1/projects/p_9"))).status).toBe(404)
	})

	it("counts every paid extract, which always fails", async () => {
		const backend = projectBackend()
		const failed = await backend.handle(ask("POST", "/v1/projects/p_1/extract"))
		expect([failed.status, JSON.parse(failed.body)]).toEqual([500, { error: "paid inference" }])
		expect(backend.extractHits()).toBe(1)
	})

	it("answers 404 off its routes and a bare 500 on a body it cannot parse", async () => {
		const { handle } = projectBackend()
		expect((await handle(ask("DELETE", "/v1/projects/p_1"))).status).toBe(404)
		expect(await handle(ask("POST", "/v1/projects", "{"))).toEqual({ body: "", headers: {}, status: 500 })
	})
})
