import { describe, expect, it } from "vitest"
import { UsageError } from "../../src/errors/usage-error.ts"
import { PRINCIPALS } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { run } from "../../src/runtime/run/index.ts"
import { pruneToAllow } from "../../src/spec/allow.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { operationResolver } from "../../src/spec/graph/resolver.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"

/*
 * Against a shared backend, some operations must never be called — not by the matrix, the
 * contract floor, a scenario or teardown. `allow` names the only ones oat may touch: every other
 * operation leaves the document before oat reads it, so nothing downstream can reach it. A config
 * that still needs a removed operation says so before anything is sent.
 */

/* `auth.token` is how every reference principal logs in; it must stay callable. */
const ALLOW = ["auth.token", "table.list", "table.get", "table.create", "table.delete"]

async function fullModel(url: string) {
	const doc = (await (await fetch(`${url}/v1/openapi/spec`)).json()) as OpenApiDocument
	return buildModel(dereference(doc).doc)
}

describe("pruneToAllow", () => {
	it("keeps only the named operations and says which it removed", async () => {
		const server = await createMemoryServer({})
		try {
			const doc = (await (await fetch(`${server.url}/v1/openapi/spec`)).json()) as OpenApiDocument
			const { doc: pruned, removed } = pruneToAllow(doc, ALLOW)
			const kept = [...buildModel(dereference(pruned).doc).byOperationId.keys()].sort()
			expect(kept).toEqual([...ALLOW].sort())
			expect(removed).toContain("table.update")
			expect(removed).not.toContain("table.list")
		} finally {
			await server.close()
		}
	})

	it("refuses an entry that names no operation", () => {
		const doc = { info: { title: "t", version: "1" }, openapi: "3.1.0", paths: {} } as OpenApiDocument
		expect(() => pruneToAllow(doc, ["table.lst"])).toThrow(UsageError)
		expect(() => pruneToAllow(doc, ["table.lst"])).toThrow(/table\.lst/)
	})
})

/* Every operation the run sent a request to on the server, or the method and path it could not name. */
async function calledOperations(result: Awaited<ReturnType<typeof run>>, serverUrl: string): Promise<Set<string>> {
	const resolve = operationResolver(await fullModel(serverUrl))
	const base = new URL(serverUrl)
	const called = new Set<string>()
	for (const exchange of result.client.transcript) {
		const url = new URL(exchange.url)
		if (url.origin !== base.origin) continue
		const op = resolve(exchange.method, url.pathname)
		called.add(op === null ? `${exchange.method} ${url.pathname}` : op.operationId)
	}
	return called
}

describe("a run under allow", () => {
	it("sends no request to an operation outside it", async () => {
		const server = await createMemoryServer({})
		try {
			const result = await run({
				allow: ALLOW,
				baseUrl: server.url,
				principals: PRINCIPALS,
				seed: 42,
				spec: `${server.url}/v1/openapi/spec`,
			})
			const called = await calledOperations(result, server.url)
			expect([...called].filter((id) => !ALLOW.includes(id))).toEqual([])
			expect(called.has("table.create")).toBe(true)
		} finally {
			await server.close()
		}
	}, 240_000)

	it("is a usage error when a scenario or an auth step needs a removed operation", async () => {
		const server = await createMemoryServer({})
		const base = {
			allow: ALLOW,
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		}
		try {
			await expect(
				run({
					...base,
					scenarios: [{ covers: ["table.update"], id: "rename", steps: [{ operationId: "table.update" }] }],
				}),
			).rejects.toThrow(/table\.update/)
			const [first, ...rest] = PRINCIPALS
			if (first === undefined) throw new Error("no principal")
			await expect(
				run({
					...base,
					principals: [
						{
							...first,
							auth: { credentialFrom: "$.token", steps: [{ operationId: "table.invite" }] },
						},
						...rest,
					],
				}),
			).rejects.toThrow(/table\.invite/)
		} finally {
			await server.close()
		}
	})
})
