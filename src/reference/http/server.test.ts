import { describe, expect, it, vi } from "vitest"
import { MemoryStore } from "../stores/memory.ts"
import { type FakeServer, fakeCreate, serve } from "./__fixtures__/fake-http.ts"
import { memoryStore } from "./engines.ts"
import { createReferenceServer } from "./server.ts"
import { PRINCIPALS } from "./state.ts"

const JSON_TYPE = { "content-type": "application/json" }

describe("createReferenceServer", () => {
	it("serves the reference on a local port, under the shape's base path", async () => {
		const servers: FakeServer[] = []
		const reference = await createReferenceServer(
			{ defects: ["STALE_LIST"], shape: "path-prefix" },
			memoryStore,
			fakeCreate(servers, 6000),
		)
		expect(reference.url).toBe("http://127.0.0.1:6000/api")
		expect(reference.principals).toBe(PRINCIPALS)
		expect(reference.defects.list()).toEqual(["STALE_LIST"])
		const listener = (servers[0] as FakeServer).listener
		const signedIn = await serve(listener, {
			chunks: [JSON.stringify({ key: "key_alpha" })],
			headers: JSON_TYPE,
			method: "POST",
			url: "/api/v1/auth/token",
		})
		const owner = {
			...JSON_TYPE,
			authorization: `Bearer ${(JSON.parse(signedIn.body) as { access_token: string }).access_token}`,
		}
		const created = await serve(listener, {
			chunks: [JSON.stringify({ name: "t" })],
			headers: owner,
			method: "POST",
			url: "/api/v1/projects/proj_alpha/tables",
		})
		expect(created.status).toBe(201)
		const { id } = JSON.parse(created.body) as { id: string }
		expect(reference.createdIds()).toEqual({ table: [id] })
		expect((await reference.snapshot())["table"]).toEqual([expect.objectContaining({ id })])
		expect((await serve(listener, { url: "/health" })).status).toBe(404)
	})

	it("closes the socket, then the store", async () => {
		const servers: FakeServer[] = []
		const store = new MemoryStore()
		const close = vi.spyOn(store, "close")
		const reference = await createReferenceServer({}, async () => store, fakeCreate(servers))
		expect(reference.server).toBeDefined()
		await reference.close()
		expect(servers[0]?.calls).toEqual(["closeAllConnections", "close"])
		expect(close).toHaveBeenCalledTimes(1)
	})
})
