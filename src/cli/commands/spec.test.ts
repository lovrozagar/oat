import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { folder, json, notesConfig, notesSpec } from "../__fixtures__/files.ts"
import { modelled } from "./spec.ts"

/* The document an offline command reads: from --spec or the config, modelled; refused with a reason. */

describe("modelled", () => {
	it("models the document --spec names", async () => {
		const read = await modelled(bufferWriter(), { spec: notesSpec() })
		expect(typeof read !== "number" && read.model.byOperationId.has("notes.create")).toBe(true)
		expect(typeof read !== "number" && read.config).toBeUndefined()
	})

	it("takes the document from the config, with what the config removes", async () => {
		const configPath = notesConfig(folder(), { allow: ["notes.list", "notes.create"], query: { grammar: "postgrest" } })
		const read = await modelled(bufferWriter(), { config: configPath })
		if (typeof read === "number") throw new Error(`refused: ${read}`)
		expect(read.configPath).toBe(configPath)
		expect(read.removed).toEqual(expect.arrayContaining(["notes.delete"]))
		expect(read.model.byOperationId.has("notes.delete")).toBe(false)
	})

	it("refuses a config it cannot use, and a run with no document", async () => {
		const writer = bufferWriter()
		expect(await modelled(writer, { config: "nowhere.config.ts" })).toBe(2)
		expect(writer.text()).toBe("oat: config not found: nowhere.config.ts\n")
		const none = bufferWriter()
		expect(await modelled(none, {})).toBe(2)
		expect(none.text()).toMatch(/^oat: --spec \(or --config\) is required\n\noat — OpenAPI Tester/)
	})

	it("refuses a config that names what the document does not have", async () => {
		const writer = bufferWriter()
		expect(await modelled(writer, { config: notesConfig(folder(), { allow: ["no.such"] }) })).toBe(2)
		expect(writer.text()).toContain('allow names "no.such"')
	})

	it("passes on an error that is not the caller's to fix", async () => {
		const missing = { $ref: "#/components/responses/missing" }
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: { "/x": { get: { responses: { "200": missing } } } },
		}
		await expect(modelled(bufferWriter(), { spec: json(folder(), "broken.json", doc) })).rejects.toThrow(
			/unresolvable \$ref/,
		)
	})
})
