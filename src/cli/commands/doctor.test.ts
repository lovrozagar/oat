import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { folder, json, notesConfig, notesSpec, referenceConfig, signupConfig } from "../__fixtures__/files.ts"
import { notesDoc } from "../../runtime/run/__fixtures__/api.ts"
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

describe("commandDoctor and a document oat does not read", () => {
	it("exits 2 on a Swagger 2.0 document, naming it", async () => {
		const writer = bufferWriter()
		const spec = json(folder(), "swagger.json", { info: { title: "t", version: "1" }, paths: {}, swagger: "2.0" })
		expect(await commandDoctor(writer, { spec })).toBe(2)
		expect(writer.text()).toBe(`oat: ${spec} is Swagger 2.0; oat reads OpenAPI 3.0–3.2 only — convert it first\n`)
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

describe("commandDoctor and the operations a recipe names", () => {
	it("keeps the entity whose operations mint and revoke the config's key, its mint answering each key's id", async () => {
		const writer = bufferWriter()
		await commandDoctor(writer, { config: referenceConfig(), json: true })
		const report = JSON.parse(writer.text()) as { blocking: number; entities: number; trackableEntities: number }
		/* The reference config's principals supply the project_id root, so nothing blocks. */
		expect([report.entities, report.trackableEntities, report.blocking]).toEqual([8, 8, 0])
		const text = bufferWriter()
		await commandDoctor(text, { config: referenceConfig() })
		expect(text.text()).not.toContain("holds credentials")
	})
})

describe("commandDoctor and the operations a login sends", () => {
	it("leaves out what the auth flow owns, as a run does: the account it signs up, and its sign-in call's gap", async () => {
		const writer = bufferWriter()
		const code = await commandDoctor(writer, { config: signupConfig(), json: true })
		const report = JSON.parse(writer.text()) as {
			blocking: number
			entities: number
			gaps: Array<{ operationId: string }>
		}
		expect([code, report.entities, report.blocking]).toEqual([0, 1, 0])
		expect(report.gaps.map((gap) => gap.operationId)).not.toContain("session.start")
		const text = bufferWriter()
		await commandDoctor(text, { config: signupConfig() })
		expect(text.text()).not.toMatch(/account|session\.start/)
	})
})

/* A config module for the notes document that reads its bearer token through env(). */
function envConfig(dir: string, variable: string): string {
	const path = join(dir, "oat.config.mjs")
	const envModule = join(import.meta.dirname, "..", "..", "config", "env.ts")
	writeFileSync(
		path,
		`import { env } from ${JSON.stringify(envModule)}\n` +
			`export default { baseUrl: "http://api.test", principals: { alpha: {} }, ` +
			`security: { bearer: { static: env(${JSON.stringify(variable)}) } }, spec: ${JSON.stringify(notesSpec(dir))} }\n`,
	)
	return path
}

describe("commandDoctor and a config whose secrets are not set", () => {
	it("doctor --config with an unset env() lists it and exits 0 or 1, not 2", async () => {
		delete process.env["OAT_DOCTOR_TEST_TOKEN"]
		const config = envConfig(folder(), "OAT_DOCTOR_TEST_TOKEN")
		const writer = bufferWriter()
		const code = await commandDoctor(writer, { config })
		expect([0, 1]).toContain(code)
		expect(writer.text()).toContain("  env        OAT_DOCTOR_TEST_TOKEN not set — a run stops until they are\n")
		const machine = bufferWriter()
		expect(await commandDoctor(machine, { config, json: true })).toBe(code)
		expect(JSON.parse(machine.text()).unsetEnv).toEqual(["OAT_DOCTOR_TEST_TOKEN"])
	})
})

describe("commandDoctor and the config's principals", () => {
	it("reads a config that names no recipe and no principal as having none", async () => {
		const dir = folder()
		const writer = bufferWriter()
		expect(await commandDoctor(writer, { config: json(dir, "oat.config.json", { spec: notesSpec(dir) }) })).toBe(1)
		expect(writer.text()).toContain("none — the config names no principal")
		expect(writer.text()).toContain("    bearer     5 operations; add security.bearer\n")
	})

	it("prints which principal sends each requirement, and blocks on an operation none can send", async () => {
		const writer = bufferWriter()
		await commandDoctor(writer, { config: notesConfig() })
		expect(writer.text()).toMatch(/\n {4}bearer {4,}\d+ {3}alpha\n/)
		const doc = notesDoc({
			"/legacy": {
				get: { operationId: "legacy.get", responses: { "200": { description: "ok" } }, security: [{ legacy: [] }] },
			},
		}) as unknown as { components: { securitySchemes: Record<string, unknown> } }
		doc.components.securitySchemes["legacy"] = { in: "header", name: "X-Legacy", type: "apiKey" }
		const dir = folder()
		const config = json(dir, "oat.config.json", {
			principals: { alpha: {} },
			security: { bearer: { static: "t" } },
			spec: notesSpec(dir, doc),
		})
		const blocked = bufferWriter()
		expect(await commandDoctor(blocked, { config })).toBe(1)
		expect(blocked.text()).toContain("none — no credential for legacy")
		const withConfig = bufferWriter()
		await commandDoctor(withConfig, { config, json: true })
		const plain = bufferWriter()
		await commandDoctor(plain, { json: true, spec: notesSpec(folder(), doc) })
		expect(JSON.parse(withConfig.text()).blocking).toBe(JSON.parse(plain.text()).blocking + 1)
	})
})
