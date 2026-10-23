import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { anyrow, everyScheme, keycloak } from "../../spec/security/__fixtures__/documents.ts"
import { folder, json } from "../__fixtures__/files.ts"
import { bufferWriter } from "../writer.ts"
import { commandInit, specFromConfig } from "./init.ts"

/* `oat init`: a starter config from the document's security schemes, written once, never over a file. */

describe("commandInit", () => {
	it("writes oat.config.ts and prints the env vars", async () => {
		const dir = folder()
		const spec = json(dir, "openapi.json", anyrow)
		const out = join(dir, "oat.config.ts")
		const writer = bufferWriter()
		expect(await commandInit(writer, { out, spec })).toBe(0)
		expect(writer.text()).toBe(
			`  wrote ${out} — 2 schemes, 1 principal\n` +
				"    set OAT_BASE_URL, OAT_API_KEY_KEY, OAT_JWT_TOKEN\n" +
				`    next: oat doctor --config ${out}\n`,
		)
		expect(readFileSync(out, "utf8")).toContain(`spec: ${JSON.stringify(spec)},`)
	})

	it("writes ./oat.config.ts by default, naming each scheme oat cannot send and why", async () => {
		const dir = folder()
		const spec = json(dir, "openapi.json", everyScheme)
		const cwd = process.cwd()
		process.chdir(dir)
		try {
			const writer = bufferWriter()
			expect(await commandInit(writer, { spec })).toBe(0)
			expect(writer.text()).toContain("  wrote oat.config.ts — 7 schemes, 1 principal\n")
			expect(writer.text()).toContain(
				"    mtls (mutualTLS) is not sent by oat: mutualTLS is a TLS client certificate, not a request credential\n",
			)
			expect(readFileSync(join(dir, "oat.config.ts"), "utf8")).toMatch(/^\/\/ Written by oat init/)
		} finally {
			process.chdir(cwd)
		}
	})

	it("says when the document declares no scheme to write a recipe for", async () => {
		const dir = folder()
		const writer = bufferWriter()
		const out = join(dir, "oat.config.mjs")
		expect(await commandInit(writer, { out, spec: json(dir, "openapi.json", keycloak) })).toBe(0)
		expect(writer.text()).toContain(`  wrote ${out} — 0 schemes, 1 principal\n    set OAT_BASE_URL\n`)
		const one = bufferWriter()
		const doc = { ...keycloak, components: { securitySchemes: { b: { scheme: "bearer", type: "http" } } } }
		const served = { ...doc, servers: [{ url: "https://api.test" }] }
		expect(await commandInit(one, { out: join(dir, "one.ts"), spec: json(dir, "one.json", served) })).toBe(0)
		expect(one.text()).toContain("1 scheme, 1 principal\n    set OAT_B_TOKEN\n")
		const none = bufferWriter()
		const anonymous = { ...keycloak, servers: [{ url: "https://api.test" }] }
		expect(await commandInit(none, { out: join(dir, "none.ts"), spec: json(dir, "none.json", anonymous) })).toBe(0)
		expect(none.text()).toBe(
			`  wrote ${join(dir, "none.ts")} — 0 schemes, 1 principal\n    next: oat doctor --config ${join(dir, "none.ts")}\n`,
		)
	})
})

describe("commandInit and the spec path", () => {
	it("writes a relative spec relative to the config's folder, an absolute one and a URL as given", async () => {
		const dir = folder()
		json(dir, "api.json", anyrow)
		mkdirSync(join(dir, "sub"))
		const cwd = process.cwd()
		process.chdir(dir)
		try {
			expect(await commandInit(bufferWriter(), { out: "sub/oat.config.ts", spec: "./api.json" })).toBe(0)
			expect(readFileSync(join(dir, "sub", "oat.config.ts"), "utf8")).toContain('spec: "../api.json",')
			expect(await commandInit(bufferWriter(), { out: "here.config.ts", spec: "api.json" })).toBe(0)
			expect(readFileSync(join(dir, "here.config.ts"), "utf8")).toContain('spec: "api.json",')
		} finally {
			process.chdir(cwd)
		}
	})

	it("keeps a URL and an absolute path as given", () => {
		expect(specFromConfig("https://api.test/openapi.json", "sub/oat.config.ts")).toBe("https://api.test/openapi.json")
		expect(specFromConfig("file:///srv/api.json", "sub/oat.config.ts")).toBe("file:///srv/api.json")
		expect(specFromConfig("/srv/api.json", "sub/oat.config.ts")).toBe("/srv/api.json")
	})
})

describe("commandInit refusals", () => {
	it("refuses to overwrite an existing file (exit 2, file unchanged) unless --force", async () => {
		const dir = folder()
		const spec = json(dir, "openapi.json", anyrow)
		const out = join(dir, "oat.config.ts")
		writeFileSync(out, "// mine\n")
		const writer = bufferWriter()
		expect(await commandInit(writer, { out, spec })).toBe(2)
		expect(writer.text()).toBe(`oat: ${out} exists; --force overwrites it\n`)
		expect(readFileSync(out, "utf8")).toBe("// mine\n")
		expect(await commandInit(bufferWriter(), { force: true, out, spec })).toBe(0)
		expect(readFileSync(out, "utf8")).toMatch(/^\/\/ Written by oat init/)
	})

	it("requires --spec", async () => {
		const writer = bufferWriter()
		expect(await commandInit(writer, { config: "oat.config.ts" })).toBe(2)
		expect(writer.text()).toMatch(/^oat: init requires --spec\n\noat — OpenAPI Tester/)
	})

	it("refuses a .json --out", async () => {
		const writer = bufferWriter()
		expect(await commandInit(writer, { out: "oat.config.json", spec: "openapi.json" })).toBe(2)
		expect(writer.text()).toBe("oat: init writes a module config (.ts, .mts, .js or .mjs), got oat.config.json\n")
	})

	it("exits 2 on a Swagger 2.0 document", async () => {
		const dir = folder()
		const writer = bufferWriter()
		const out = join(dir, "oat.config.ts")
		expect(await commandInit(writer, { out, spec: json(dir, "swagger.json", { swagger: "2.0" }) })).toBe(2)
		expect(writer.text()).toMatch(/^oat: .*swagger\.json is Swagger 2\.0; /)
	})

	it("lets any other failure through, as doctor does", async () => {
		const dir = folder()
		await expect(commandInit(bufferWriter(), { spec: join(dir, "missing.json") })).rejects.toThrow(
			/could not find a specification/,
		)
		const spec = json(dir, "openapi.json", anyrow)
		await expect(commandInit(bufferWriter(), { out: join(dir, "no", "dir.ts"), spec })).rejects.toThrow(/ENOENT/)
	})
})
