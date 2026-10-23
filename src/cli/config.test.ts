import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readConfig } from "./config.ts"

/* A config the command cannot use is the caller's to fix: one line saying why, before any request. */

const dir = (): string => mkdtempSync(join(tmpdir(), "oat-config-"))

function configFile(body: unknown): string {
	const path = join(dir(), "oat.config.json")
	writeFileSync(path, JSON.stringify(body))
	return path
}

describe("readConfig", () => {
	it("says a config that is not there is not found, naming the path", async () => {
		const path = join(dir(), "missing.config.ts")
		expect(await readConfig(path, true)).toEqual({ problem: `config not found: ${path}` })
	})

	it("loads, checks and interpolates a config", async () => {
		process.env["OAT_CONFIG_TEST_URL"] = "http://api.test"
		const path = configFile({ baseUrl: "${OAT_CONFIG_TEST_URL}", principals: { a: {} }, spec: "s.yaml" })
		expect(await readConfig(path, true)).toEqual({
			config: { baseUrl: "http://api.test", principals: { a: {} }, spec: "s.yaml" },
		})
	})

	it("lists every problem with a config it can read", async () => {
		const read = await readConfig(configFile({ principals: "nobody" }), true)
		expect("problem" in read && read.problem).toMatch(/is not a valid config:\n {2}/)
	})

	it("says why a config file cannot be loaded", async () => {
		const path = join(dir(), "broken.config.json")
		writeFileSync(path, "{ not json")
		const read = await readConfig(path, false)
		expect("problem" in read && read.problem).not.toMatch(/^oat: /)
	})

	it("says which variable a config names that is not set", async () => {
		delete process.env["OAT_CONFIG_TEST_UNSET"]
		const read = await readConfig(configFile({ baseUrl: "${OAT_CONFIG_TEST_UNSET}", spec: "s.yaml" }), false)
		expect("problem" in read && read.problem).toContain("OAT_CONFIG_TEST_UNSET")
	})

	it("says why a config module threw, whatever it threw", async () => {
		const path = join(dir(), "throws.config.mjs")
		writeFileSync(path, 'throw "no config today"\n')
		expect(await readConfig(path, false)).toEqual({ problem: `failed to load config ${path}: no config today` })
	})
})

describe("readConfig deferring env", () => {
	it("defers an unset variable for doctor and plan, through env() and ${NAME} alike, and lists each once", async () => {
		delete process.env["OAT_CONFIG_TEST_UNSET"]
		delete process.env["OAT_CONFIG_TEST_KEY"]
		const path = join(dir(), "oat.config.mjs")
		const envModule = join(import.meta.dirname, "..", "config", "env.ts")
		writeFileSync(
			path,
			`import { env } from ${JSON.stringify(envModule)}\n` +
				`export default { baseUrl: "\${OAT_CONFIG_TEST_UNSET}", principals: { a: {} }, spec: "s.yaml", ` +
				`security: { jwt: { static: env("OAT_CONFIG_TEST_KEY") }, key: { static: "\${OAT_CONFIG_TEST_UNSET}" } } }\n`,
		)
		expect(await readConfig(path, false, { deferEnv: true })).toEqual({
			config: {
				baseUrl: "${OAT_CONFIG_TEST_UNSET}",
				principals: { a: {} },
				security: { jwt: { static: "${OAT_CONFIG_TEST_KEY}" }, key: { static: "${OAT_CONFIG_TEST_UNSET}" } },
				spec: "s.yaml",
			},
			unsetEnv: ["OAT_CONFIG_TEST_UNSET", "OAT_CONFIG_TEST_KEY"],
		})
	})

	it("never defers ${NAME} for a run, though OAT_DEFER_ENV=1 is exported", async () => {
		delete process.env["OAT_CONFIG_TEST_UNSET"]
		process.env["OAT_DEFER_ENV"] = "1"
		try {
			const read = await readConfig(
				configFile({ baseUrl: "${OAT_CONFIG_TEST_UNSET}", principals: { a: {} }, spec: "s.yaml" }),
				true,
			)
			expect("problem" in read && read.problem).toContain("OAT_CONFIG_TEST_UNSET")
		} finally {
			delete process.env["OAT_DEFER_ENV"]
		}
	})
})
