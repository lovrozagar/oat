import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { UsageError } from "../../errors/usage-error.ts"
import type { JsonSchema, OpenApiDocument } from "../types.ts"
import { bundleLocalRefs, EXTERNAL_KEY } from "./bundle.ts"
import { DEFS_KEY } from "./defs.ts"
import { dereference } from "./dereference.ts"
import { parseDocument } from "./parse.ts"

const SPLIT = join(import.meta.dirname, "__fixtures__", "split", "openapi.yaml")
const made: string[] = []

afterAll(() => {
	for (const dir of made) rmSync(dir, { force: true, recursive: true })
})

/* A fresh folder holding `files` (path → JSON body, or text); returns the folder. */
function tree(files: Record<string, unknown>): string {
	const root = mkdtempSync(join(tmpdir(), "oat-bundle-"))
	made.push(root)
	for (const [path, body] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true })
		writeFileSync(join(root, path), typeof body === "string" ? body : JSON.stringify(body))
	}
	return root
}

/* A document whose one response schema is `$ref: ref`. */
function referring(ref: string): Record<string, unknown> {
	const schema = { $ref: ref }
	const content = { "application/json": { schema } }
	return {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: { "/x": { get: { responses: { "200": { content, description: "x" } } } } },
	}
}

async function bundled(path: string): Promise<OpenApiDocument> {
	return bundleLocalRefs(await parseDocument(await readFile(path, "utf8"), path), path)
}

function schemaOf(doc: OpenApiDocument): JsonSchema {
	const paths = doc.paths as Record<string, any>
	return paths["/x"].get.responses["200"].content["application/json"].schema
}

describe("bundleLocalRefs", () => {
	it("reads each file a ref names, relative to the file that names it, under one key per file", async () => {
		const doc = (await bundled(SPLIT)) as Record<string, any>
		const pet = doc[EXTERNAL_KEY]["schemas/pet.yaml"]
		expect(Object.keys(doc[EXTERNAL_KEY])).toEqual(["schemas/pet.yaml", "schemas/tag.yaml"])
		expect(doc.paths["/pets/{id}"].get.responses["200"].content["application/json"].schema).toEqual({
			$ref: `#/${EXTERNAL_KEY}/schemas~1pet.yaml/Pet`,
		})
		/* The external file's own `#/` ref, its nested relative ref, and its ref back into the root. */
		expect(pet.Pet.properties).toEqual({
			id: { $ref: `#/${EXTERNAL_KEY}/schemas~1pet.yaml/Id` },
			owner: { $ref: "#/components/schemas/Owner" },
			tag: { $ref: `#/${EXTERNAL_KEY}/schemas~1tag.yaml` },
		})
		/* An example is data: a `$ref` inside it is not a reference. */
		expect(pet.Pet.example.note).toEqual({ $ref: "data.yaml" })
	})

	it("leaves nothing external once dereferenced, and a cross-file cycle becomes a definition", async () => {
		const { doc, externalRefs } = dereference(await bundled(SPLIT))
		const out = doc as Record<string, any>
		expect(externalRefs).toEqual([])
		const pet = out.paths["/pets/{id}"].get.responses["200"].content["application/json"].schema
		expect(pet.properties.tag).toEqual({ enum: ["cat", "dog"], type: "string" })
		expect(pet.properties.id).toEqual({ format: "uuid", type: "string" })
		expect(pet.properties.owner.properties.pets.items).toEqual({ $ref: "oat-defs#/$defs/Pet" })
		expect(Object.keys(out[DEFS_KEY])).toEqual(["Pet"])
		expect(out.paths["/pets/{id}"].get.parameters[0].schema).toEqual({ format: "uuid", type: "string" })
	})

	it("reads a file once however often it is named, and follows a cycle between two other files", async () => {
		const root = tree({
			"a.json": { A: { properties: { b: { $ref: "b.json#/B" } } } },
			"b.json": { B: { properties: { a: { $ref: "./a.json#/A" }, again: { $ref: "a.json#/A" } } } },
			"openapi.json": referring("a.json#/A"),
		})
		const doc = (await bundled(join(root, "openapi.json"))) as Record<string, any>
		expect(Object.keys(doc[EXTERNAL_KEY])).toEqual(["a.json", "b.json"])
		expect(doc[EXTERNAL_KEY]["b.json"].B.properties.a).toEqual({ $ref: `#/${EXTERNAL_KEY}/a.json/A` })
		const { doc: out, externalRefs } = dereference(doc as OpenApiDocument)
		expect(externalRefs).toEqual([])
		expect(schemaOf(out)).toEqual({ properties: { b: { properties: expect.any(Object) } } })
	})
})

describe("bundleLocalRefs and a ref outside the document's folder", () => {
	it("refuses a ref that climbs out of the document's folder", async () => {
		const root = tree({ "outside.json": { type: "string" }, "spec/openapi.json": referring("../outside.json") })
		const path = join(root, "spec", "openapi.json")
		await expect(bundled(path)).rejects.toThrow(
			new UsageError(
				`oat: ${path} refers to ../outside.json, which resolves outside ${join(root, "spec")}; ` +
					"oat reads only files in the document's folder",
			),
		)
	})

	it("refuses a ref by absolute path or file URL", async () => {
		const root = tree({ "s.json": { type: "string" } })
		for (const ref of [join(root, "s.json"), `file://${join(root, "s.json")}`]) {
			const path = join(tree({ "openapi.json": referring(ref) }), "openapi.json")
			await expect(bundled(path)).rejects.toThrow(
				new UsageError(
					`oat: ${path} refers to ${ref}, an absolute path; oat reads only paths relative to the document`,
				),
			)
		}
	})

	it("refuses a symlink inside the folder that points outside it", async () => {
		const outside = tree({ "secret.json": { type: "string" } })
		const root = tree({ "openapi.json": referring("link.json") })
		symlinkSync(join(outside, "secret.json"), join(root, "link.json"))
		await expect(bundled(join(root, "openapi.json"))).rejects.toThrow(/refers to link\.json, which resolves outside/)
	})
})

describe("bundleLocalRefs and what a ref names", () => {
	it("follows a symlink that stays inside the folder, and a document reached through a linked folder", async () => {
		const root = tree({ "real/openapi.json": referring("s.json"), "real/s.json": { type: "string" } })
		symlinkSync(join(root, "real", "s.json"), join(root, "real", "alias.json"))
		symlinkSync(join(root, "real"), join(root, "linked"))
		expect(schemaOf(await bundled(join(root, "linked", "openapi.json")))).toEqual({
			$ref: `#/${EXTERNAL_KEY}/s.json`,
		})
		writeFileSync(join(root, "real", "openapi.json"), JSON.stringify(referring("alias.json")))
		const doc = (await bundled(join(root, "real", "openapi.json"))) as Record<string, any>
		expect(Object.keys(doc[EXTERNAL_KEY])).toEqual(["s.json"])
	})

	it("leaves a URL ref, an anchor and an internal ref of the document alone", async () => {
		for (const ref of ["https://example.test/s.json#/S", "urn:x:y", "s.json#Anchor", "#/components/schemas/S"]) {
			const doc = await bundled(join(tree({ "openapi.json": referring(ref) }), "openapi.json"))
			expect(schemaOf(doc)).toEqual({ $ref: ref })
			expect(EXTERNAL_KEY in doc).toBe(false)
		}
	})

	it("decodes a percent-encoded file name, and escapes the key as a pointer segment", async () => {
		const root = tree({ "my file~v%1.json": { type: "string" }, "openapi.json": referring("my%20file~v%251.json") })
		const doc = (await bundled(join(root, "openapi.json"))) as Record<string, any>
		expect(schemaOf(doc)).toEqual({ $ref: `#/${EXTERNAL_KEY}/my file~0v%251.json` })
		expect(dereference(doc as OpenApiDocument).doc.paths).toBeDefined()
		expect(schemaOf(dereference(doc as OpenApiDocument).doc)).toEqual({ type: "string" })
		/* A malformed escape is taken as written. */
		const raw = tree({ "a%zz.json": { type: "string" }, "openapi.json": referring("a%zz.json") })
		expect(schemaOf(await bundled(join(raw, "openapi.json")))).toEqual({ $ref: `#/${EXTERNAL_KEY}/a%25zz.json` })
	})
})

describe("bundleLocalRefs and a file it cannot use", () => {
	it("names the missing file and the file that refers to it", async () => {
		const root = tree({ "openapi.json": referring("s.json#/S"), "s.json": { S: { $ref: "gone.yaml" } } })
		await expect(bundled(join(root, "openapi.json"))).rejects.toThrow(
			new UsageError(`oat: ${join(root, "s.json")} refers to gone.yaml, but ${join(root, "gone.yaml")} does not exist`),
		)
	})

	it("passes on a read failure other than a missing file, and names a file that does not parse", async () => {
		const root = tree({ "openapi.json": referring("s.json/inner.json"), "s.json": { type: "string" } })
		await expect(bundled(join(root, "openapi.json"))).rejects.toMatchObject({ code: "ENOTDIR" })
		const bad = tree({ "bad.json": "{", "openapi.json": referring("bad.json") })
		await expect(bundled(join(bad, "openapi.json"))).rejects.toThrow(`oat: ${join(bad, "bad.json")} starts as JSON`)
	})

	it("rewrites a node a YAML alias shares once, in an external file too", async () => {
		const root = tree({
			"openapi.json": referring("s.yaml#/B"),
			"s.yaml": "A: &a { $ref: t.json }\nB: *a\n",
			"t.json": {},
		})
		const doc = (await bundled(join(root, "openapi.json"))) as Record<string, any>
		const ref = `#/${EXTERNAL_KEY}/t.json`
		expect(doc[EXTERNAL_KEY]["s.yaml"]).toEqual({ A: { $ref: ref }, B: { $ref: ref } })
	})

	it("walks Example Objects as examples: their refs are refs, their values data", async () => {
		const response = {
			content: {
				"application/json": {
					examples: { a: { $ref: "ex.json" }, b: { value: { $ref: "data" } } },
					schema: { examples: [{ $ref: "data" }], type: "object" },
				},
			},
			description: "x",
		}
		const doc = { ...referring("#"), paths: { "/x": { get: { responses: { "200": response } } } } }
		const root = tree({ "ex.json": { value: { id: 1 } }, "openapi.json": doc })
		const out = (await bundled(join(root, "openapi.json"))) as Record<string, any>
		const media = out.paths["/x"].get.responses["200"].content["application/json"]
		expect(media.examples).toEqual({ a: { $ref: `#/${EXTERNAL_KEY}/ex.json` }, b: { value: { $ref: "data" } } })
		expect(media.schema.examples).toEqual([{ $ref: "data" }])
		expect(out[EXTERNAL_KEY]["ex.json"]).toEqual({ value: { id: 1 } })
	})
})
