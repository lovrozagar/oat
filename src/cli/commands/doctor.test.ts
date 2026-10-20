import { existsSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { folder, json, notesConfig, notesSpec } from "../__fixtures__/files.ts"
import { commandDoctor } from "./doctor.ts"

/* What oat can and cannot test in a document, and why; exits 1 when something blocks testing. */

describe("commandDoctor", () => {
	it("reports on a document, as text or JSON", async () => {
		const text = bufferWriter()
		const code = await commandDoctor(text, { spec: notesSpec() })
		expect([0, 1]).toContain(code)
		expect(text.text().length).toBeGreaterThan(0)
		const machine = bufferWriter()
		await commandDoctor(machine, { json: true, spec: notesSpec() })
		expect(() => JSON.parse(machine.text())).not.toThrow()
	})

	it("reads the config's query, entities, hooks and allow list, and names a missing baseline", async () => {
		const dir = folder()
		const configPath = notesConfig(dir, {
			allow: ["notes.list", "notes.create", "notes.get", "notes.update", "notes.delete"],
			baseline: "known.json",
			entities: { note: {} },
			hooks: {},
			query: { searchable: ["title"] },
		})
		const writer = bufferWriter()
		await commandDoctor(writer, { config: configPath })
		expect(writer.text()).toContain(`baseline   ${join(dir, "known.json")} does not exist`)
	})

	it("says nothing of a baseline that is there, or of a config with none", async () => {
		const dir = folder()
		json(dir, "known.json", { entries: [], version: 1 })
		const writer = bufferWriter()
		await commandDoctor(writer, { config: notesConfig(dir, { baseline: "known.json" }) })
		expect(existsSync(join(dir, "known.json"))).toBe(true)
		expect(writer.text()).not.toContain("does not exist")
		const plain = bufferWriter()
		await commandDoctor(plain, { config: notesConfig(folder()) })
		expect(plain.text()).not.toContain("baseline")
	})

	it("blocks on a document whose operations oat cannot reach, and refuses one it cannot read", async () => {
		const unreachable = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: {
				"/a/{id}": {
					delete: {
						operationId: "a.delete",
						parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
						responses: { "204": { description: "x" } },
					},
				},
			},
		}
		const writer = bufferWriter()
		const code = await commandDoctor(writer, { spec: notesSpec(folder(), unreachable) })
		expect([0, 1]).toContain(code)
		expect(await commandDoctor(bufferWriter(), {})).toBe(2)
	})
})

describe("commandDoctor and the credentials config", () => {
	it("exits 2 and names the problem when the config's credentials do not fit the document", async () => {
		const writer = bufferWriter()
		const code = await commandDoctor(writer, {
			config: notesConfig(folder(), { security: { jwt: { static: "t" } } }),
		})
		expect(code).toBe(2)
		expect(writer.text()).toContain("security.jwt names no scheme in the document")
	})
})
