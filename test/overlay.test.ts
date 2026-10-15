import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { main } from "../src/cli.ts"
import { PRINCIPALS } from "../src/conformance/suite.ts"
import { UsageError } from "../src/config/usage-error.ts"
import { createMemoryServer } from "../src/reference/http.ts"
import { run } from "../src/runtime/run.ts"
import { applyOverlay } from "../src/spec/overlay.ts"
import type { OpenApiDocument } from "../src/spec/types.ts"

/*
 * A team testing a backend whose document it cannot change patches the document from config:
 * an operation by its id, a component schema by its name. Objects merge, arrays replace, and
 * `null` deletes a key. A patch naming nothing that exists is a mistake in the config, not
 * something to skip quietly.
 */

const DOC = {
	components: {
		schemas: {
			Note: {
				properties: { body: { type: "string" }, title: { maxLength: 10, type: "string" } },
				required: ["title"],
				type: "object",
			},
		},
	},
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/notes": {
			get: {
				operationId: "notes.list",
				parameters: [
					{ in: "query", name: "a", schema: { type: "string" } },
					{ in: "query", name: "b", schema: { type: "string" } },
				],
				responses: { "200": { description: "ok" } },
				summary: "List notes",
				"x-query": { filterable: ["title"], maxLimit: 50 },
			},
		},
	},
} as unknown as OpenApiDocument

const listOf = (doc: OpenApiDocument): Record<string, unknown> =>
	((doc.paths ?? {})["/notes"] as Record<string, Record<string, unknown>> | undefined)?.get ?? {}

describe("applyOverlay", () => {
	it("merges objects, replaces arrays and deletes on null", () => {
		const patched = applyOverlay(DOC, {
			operations: {
				"notes.list": {
					parameters: [{ in: "query", name: "c", schema: { type: "string" } }],
					summary: null,
					"x-query": { maxLimit: 20, sortable: ["title"] },
				},
			},
		})
		const list = listOf(patched)
		expect(list.parameters).toEqual([{ in: "query", name: "c", schema: { type: "string" } }])
		expect(list).not.toHaveProperty("summary")
		expect(list["x-query"]).toEqual({ filterable: ["title"], maxLimit: 20, sortable: ["title"] })
		/* The document it was given is left as it was. */
		expect(listOf(DOC).summary).toBe("List notes")
	})

	it("patches a component schema by name", () => {
		const patched = applyOverlay(DOC, { schemas: { Note: { properties: { title: { maxLength: 40 } } } } })
		const schemas = (patched.components?.schemas ?? {}) as Record<string, { properties: Record<string, unknown> }>
		expect(schemas.Note?.properties.title).toEqual({ maxLength: 40, type: "string" })
	})

	it("renames an operation when the patch gives it a new id", () => {
		const patched = applyOverlay(DOC, { operations: { "notes.list": { operationId: "note.list" } } })
		expect(listOf(patched).operationId).toBe("note.list")
	})

	it("refuses a patch that names nothing, saying which", () => {
		expect(() => applyOverlay(DOC, { operations: { "notes.lst": {} } })).toThrow(UsageError)
		expect(() => applyOverlay(DOC, { operations: { "notes.lst": {} } })).toThrow(/notes\.lst/)
		expect(() => applyOverlay(DOC, { schemas: { Nope: {} } })).toThrow(/Nope/)
	})
})

async function checksRunWith(overlay?: Parameters<typeof applyOverlay>[1]): Promise<string[]> {
	const server = await createMemoryServer({})
	try {
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
			...(overlay === undefined ? {} : { overlay }),
		})
		return result.checksRun
	} finally {
		await server.close()
	}
}

describe("run with an overlay", () => {
	it("tests the document as the overlay leaves it", async () => {
		expect(await checksRunWith()).toContain("create.unique-conflict-rejected")
		/* The overlay takes the uniqueness claim away, so nothing is left to check it against. */
		const without = await checksRunWith({ operations: { "table.create": { "x-unique": null } } })
		expect(without).not.toContain("create.unique-conflict-rejected")
	}, 240_000)

	it("is a usage error when the overlay names an operation the document lacks", async () => {
		const server = await createMemoryServer({})
		try {
			await expect(
				run({
					baseUrl: server.url,
					overlay: { operations: { "table.creat": {} } },
					principals: PRINCIPALS,
					seed: 42,
					spec: `${server.url}/v1/openapi/spec`,
				}),
			).rejects.toThrow(UsageError)
		} finally {
			await server.close()
		}
	})
})

async function cli(argv: string[]): Promise<{ code: number; out: string }> {
	const saved = process.argv
	const chunks: string[] = []
	const capture = (chunk: string | Uint8Array): boolean => {
		chunks.push(String(chunk))
		return true
	}
	const write = vi.spyOn(process.stdout, "write").mockImplementation(capture)
	const err = vi.spyOn(process.stderr, "write").mockImplementation(capture)
	process.argv = ["node", "oat", ...argv]
	try {
		return { code: await main(), out: chunks.join("") }
	} finally {
		process.argv = saved
		write.mockRestore()
		err.mockRestore()
	}
}

describe("oat doctor with an overlay", () => {
	it("reads the document as the overlay leaves it, and names a patch that matches nothing", async () => {
		const server = await createMemoryServer({})
		const dir = await mkdtemp(join(tmpdir(), "oat-overlay-"))
		const config = async (overlay: Record<string, unknown>): Promise<string> => {
			const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`)
			await writeFile(path, JSON.stringify({ baseUrl: server.url, overlay, spec: `${server.url}/v1/openapi/spec` }))
			return path
		}
		try {
			const plain = await cli(["doctor", "--config", await config({})])
			expect(plain.out).toContain("x-unique:")
			const patched = await cli([
				"doctor",
				"--config",
				await config({ operations: { "table.create": { "x-unique": null } } }),
			])
			expect(patched.out).not.toContain("x-unique:")
			const wrong = await cli(["doctor", "--config", await config({ operations: { "table.creat": {} } })])
			expect(wrong.code).toBe(2)
			expect(wrong.out).toContain("table.creat")
		} finally {
			await server.close()
			await rm(dir, { force: true, recursive: true })
		}
	})
})
