import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { bufferWriter } from "../writer.ts"
import { folder, json, notesConfig, notesSpec, referenceConfig, signupConfig } from "../__fixtures__/files.ts"
import { commandPlan, targetedScope } from "./plan.ts"

/* The test model, offline: in full, or narrowed to what --ops or --only (or the config) target. */

describe("commandPlan", () => {
	it("prints the model of the whole document", async () => {
		const writer = bufferWriter()
		expect(await commandPlan(writer, { spec: notesSpec() })).toBe(0)
		expect(writer.text()).toContain("5 operations · 1 entities")
	})

	it("prints the model as JSON, narrowed to the targets", async () => {
		const writer = bufferWriter()
		expect(await commandPlan(writer, { json: true, ops: "notes.list", spec: notesSpec() })).toBe(0)
		const plan = JSON.parse(writer.text()) as { scope?: { mode: string } }
		expect(JSON.stringify(plan)).toContain("notes.list")
	})

	it("narrows to the entities the config names, and to its targets", async () => {
		const byEntity = bufferWriter()
		expect(await commandPlan(byEntity, { config: notesConfig(folder(), { only: ["note"] }) })).toBe(0)
		const byOps = bufferWriter()
		expect(await commandPlan(byOps, { config: notesConfig(folder(), { ops: ["notes.get"] }) })).toBe(0)
		expect(byOps.text()).toContain("notes.get")
	})

	it("leaves out the entity whose operations mint and revoke the config's key, as a run does", async () => {
		const writer = bufferWriter()
		expect(await commandPlan(writer, { config: referenceConfig() })).toBe(0)
		expect(writer.text()).toMatch(/ operations · 6 entities\n/)
		expect(writer.text()).not.toContain("api-key")
		const machine = bufferWriter()
		await commandPlan(machine, { config: referenceConfig(), json: true })
		const plan = JSON.parse(machine.text()) as { entities: Array<{ name: string }> }
		expect(plan.entities.map((entity) => entity.name)).not.toContain("api-key")
	})

	it("leaves out the account a login signs up, as a run does", async () => {
		const writer = bufferWriter()
		expect(await commandPlan(writer, { config: signupConfig() })).toBe(0)
		expect(writer.text()).toMatch(/ operations · 1 entities\n/)
		const machine = bufferWriter()
		await commandPlan(machine, { config: signupConfig(), json: true })
		const plan = JSON.parse(machine.text()) as { entities: Array<{ name: string }> }
		expect(plan.entities.map((entity) => entity.name)).toEqual(["note"])
	})

	it("refuses a target that names nothing, and a document it cannot read", async () => {
		const writer = bufferWriter()
		expect(await commandPlan(writer, { ops: "no.such", spec: notesSpec() })).toBe(2)
		expect(writer.text()).toMatch(/no\.such/)
		expect(await commandPlan(bufferWriter(), {})).toBe(2)
	})

	it("exits 2 on a Swagger 2.0 document, naming it", async () => {
		const writer = bufferWriter()
		const spec = json(folder(), "swagger.json", { info: { title: "t", version: "1" }, paths: {}, swagger: "2.0" })
		expect(await commandPlan(writer, { spec })).toBe(2)
		expect(writer.text()).toBe(`oat: ${spec} is Swagger 2.0; oat reads OpenAPI 3.0–3.2 only — convert it first\n`)
	})
})

describe("commandPlan and the config's credentials", () => {
	it("prints each operation's requirement and principal, and lists an unset env() on stderr and in JSON", async () => {
		delete process.env.OAT_PLAN_TEST_TOKEN
		const dir = folder()
		const path = join(dir, "oat.config.mjs")
		const envModule = join(import.meta.dirname, "..", "..", "config", "env.ts")
		writeFileSync(
			path,
			`import { env } from ${JSON.stringify(envModule)}\n` +
				`export default { principals: { alpha: {} }, security: { bearer: { static: env("OAT_PLAN_TEST_TOKEN") } }, ` +
				`spec: ${JSON.stringify(notesSpec(dir))} }\n`,
		)
		const lines: { out: string[]; err: string[] } = { err: [], out: [] }
		const writer = {
			err: (text: string) => lines.err.push(text),
			flush: () => undefined,
			out: (text: string) => lines.out.push(text),
		}
		expect(await commandPlan(writer, { config: path })).toBe(0)
		expect(lines.err).toEqual(["  env        OAT_PLAN_TEST_TOKEN not set — a run stops until they are\n"])
		expect(lines.out.join("")).toMatch(/\n {4}notes\.create {3,}bearer {3}alpha\n/)
		const machine = bufferWriter()
		expect(await commandPlan(machine, { config: path, json: true })).toBe(0)
		const plan = JSON.parse(machine.text().slice(machine.text().indexOf("{"))) as {
			security: { operations: Array<{ satisfiedBy?: unknown }> }
			unsetEnv: string[]
		}
		expect(plan.unsetEnv).toEqual(["OAT_PLAN_TEST_TOKEN"])
		expect(plan.security.operations.every((op) => op.satisfiedBy !== undefined)).toBe(true)
		const quiet = bufferWriter()
		await commandPlan(quiet, { config: notesConfig() })
		expect(quiet.text()).not.toContain("not set")
		const bare = bufferWriter()
		expect(await commandPlan(bare, { config: json(dir, "bare.json", { spec: notesSpec(dir) }) })).toBe(0)
		expect(bare.text()).toMatch(/\n {4}notes\.create {3,}bearer {3}none — the config names no principal\n/)
	})
})

describe("targetedScope", () => {
	it("passes on an error that is no mistake of the caller's", () => {
		expect(() => targetedScope({} as never, { authCreates: new Set() })).toThrow(TypeError)
	})
})
