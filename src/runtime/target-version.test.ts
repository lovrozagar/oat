import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "../spec/types.ts"
import { fakeClient, modelOf, type Responder } from "./checks/__fixtures__/harness.ts"
import { readTargetVersion, type TargetVersionSpec } from "./target-version.ts"

const model = modelOf({
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/projects/{projectId}/version": {
			get: {
				operationId: "meta.version",
				parameters: [{ in: "path", name: "projectId", required: true, schema: { type: "string" } }],
				responses: { "200": { description: "ok" } },
			},
		},
	},
} as unknown as OpenApiDocument)

const answers: Responder = (_method, path) => {
	if (path === "/projects/p%201/version") return { body: { build: { id: 42 } }, status: 200 }
	if (path === "/version") return { body: { build: "b-7" }, headers: { "X-Build": "h-9" }, status: 200 }
	return { status: 503 }
}

function read(spec: TargetVersionSpec, respond: Responder = answers) {
	const { client, sent } = fakeClient(respond)
	const result = readTargetVersion({
		client,
		headers: () => ({ authorization: "Bearer a" }),
		model,
		roots: { projectId: "p 1" },
		spec,
	})
	return { result, sent }
}

describe("readTargetVersion", () => {
	it("reads the operation's route, filled from the roots, as the first principal", async () => {
		const { result, sent } = read({ from: "$.build.id", operationId: "meta.version" })
		expect(await result).toEqual({ value: "42" })
		expect(sent[0]?.options).toEqual({ headers: { authorization: "Bearer a" }, operationId: "meta.version" })
	})

	it("reads a configured path, from the body or from a header in any case", async () => {
		expect(await read({ from: "$.build", path: "/version" }).result).toEqual({ value: "b-7" })
		expect(await read({ from: "Header: x-build ", path: "/version" }).result).toEqual({ value: "h-9" })
	})

	it("says why the version could not be read", async () => {
		expect(await read({ from: "$.build" }).result).toEqual({ error: "targetVersion needs an operationId or a path" })
		expect(await read({ from: "$.build", operationId: "ghost" }).result).toEqual({
			error: 'targetVersion.operationId "ghost" names no operation',
		})
		expect(await read({ from: "$.missing", path: "/version" }).result).toEqual({
			error: "$.missing is not in the response of GET /version",
		})
		expect(await read({ from: "header:x-none", path: "/version" }).result).toEqual({
			error: "header:x-none is not in the response of GET /version",
		})
		expect(await read({ from: "$.build", path: "/down" }).result).toEqual({ error: "GET /down returned 503" })
		expect(await read({ from: "$.build", path: "/down" }, () => ({ status: 199 })).result).toEqual({
			error: "GET /down returned 199",
		})
	})

	it("reports a path id the roots lack, and a request the client refused", async () => {
		const bare = await readTargetVersion({
			client: fakeClient(answers).client,
			headers: () => ({}),
			model,
			roots: {},
			spec: { from: "$.build", operationId: "meta.version" },
		})
		expect(bare).toEqual({ error: "no value for path parameter {projectId}" })
		const refused = await readTargetVersion({
			client: { get: () => Promise.reject(new Error("blocked by the fence")) },
			headers: () => ({}),
			model,
			roots: {},
			spec: { from: "$.build", path: "/version" },
		})
		expect(refused).toEqual({ error: "blocked by the fence" })
	})
})
