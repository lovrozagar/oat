import { mkdirSync } from "node:fs"
import { join } from "node:path"
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

	it("checks the config's credentials against the document and each origin's", async () => {
		const dir = folder()
		const origins = [
			{ baseUrl: "http://cdn.test", id: "cdn", security: { bearer: "bearer" }, spec: notesSpec(folder()) },
		]
		const read = await modelled(bufferWriter(), { config: notesConfig(dir, { origins }) })
		expect(typeof read !== "number" && read.model.byOperationId.has("notes.create")).toBe(true)
		const writer = bufferWriter()
		const misfit = notesConfig(folder(), { origins, security: { nope: { static: "x" } } })
		expect(await modelled(writer, { config: misfit })).toBe(2)
		expect(writer.text()).toBe(
			"the config's credentials do not fit the document:\n  security.nope names no scheme in the document. The document declares: bearer\n",
		)
	})
})

describe("modelled and relative paths", () => {
	it("reads a config's relative spec and origin specs from the config's folder, from any working directory", async () => {
		const dir = folder()
		notesSpec(dir)
		mkdirSync(join(dir, "cdn"))
		notesSpec(join(dir, "cdn"))
		const origins = [
			{ baseUrl: "http://cdn.test", id: "cdn", security: { bearer: "bearer" }, spec: "cdn/openapi.json" },
		]
		const config = notesConfig(dir, { origins, spec: "openapi.json" })
		const read = await modelled(bufferWriter(), { config })
		expect(typeof read !== "number" && read.model.byOperationId.has("notes.create")).toBe(true)
	})

	it("reads a relative --spec from the working directory, though a config names another folder", async () => {
		const here = folder()
		notesSpec(here)
		const cwd = process.cwd()
		process.chdir(here)
		try {
			const read = await modelled(bufferWriter(), { config: notesConfig(folder()), spec: "openapi.json" })
			expect(typeof read !== "number" && read.model.byOperationId.has("notes.create")).toBe(true)
		} finally {
			process.chdir(cwd)
		}
	})
})

describe("modelled and the files a document refers to", () => {
	it("reads the files a document refers to, and refuses one outside its folder", async () => {
		const split = join(import.meta.dirname, "..", "..", "spec", "load", "__fixtures__", "split", "openapi.yaml")
		const read = await modelled(bufferWriter(), { spec: split })
		if (typeof read === "number") throw new Error(`refused: ${read}`)
		expect(read.externalRefs).toEqual([])
		expect(read.model.byOperationId.has("pets.read")).toBe(true)
		const dir = folder()
		json(dir, "outside.json", { type: "string" })
		const response = { content: { "application/json": { schema: { $ref: "../outside.json" } } }, description: "x" }
		const doc = {
			info: { title: "t", version: "1" },
			openapi: "3.1.0",
			paths: { "/x": { get: { responses: { "200": response } } } },
		}
		const inner = join(dir, "inner")
		mkdirSync(inner)
		const spec = json(inner, "openapi.json", doc)
		const writer = bufferWriter()
		expect(await modelled(writer, { spec })).toBe(2)
		expect(writer.text()).toBe(
			`oat: ${spec} refers to ../outside.json, which resolves outside ${inner}; oat reads only files in the document's folder\n`,
		)
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

describe("modelled and a config whose variables are not set", () => {
	it("reads it, listing each unset variable, and resolves no document against an unset base URL", async () => {
		delete process.env["OAT_SPEC_TEST_TOKEN"]
		delete process.env["OAT_SPEC_TEST_URL"]
		const dir = folder()
		const configPath = notesConfig(dir, { security: { bearer: { static: "${OAT_SPEC_TEST_TOKEN}" } } })
		const read = await modelled(bufferWriter(), { config: configPath })
		if (typeof read === "number") throw new Error(`refused: ${read}`)
		expect(read.unsetEnv).toEqual(["OAT_SPEC_TEST_TOKEN"])
		const routed = json(dir, "routed.json", {
			baseUrl: "${OAT_SPEC_TEST_URL}",
			principals: { alpha: {} },
			spec: "v1/openapi",
		})
		await expect(modelled(bufferWriter(), { config: routed })).rejects.toThrow(
			'could not find a specification at "v1/openapi"',
		)
		const bare = await modelled(bufferWriter(), { spec: notesSpec() })
		expect(typeof bare !== "number" && bare.unsetEnv).toBeUndefined()
	})
})
