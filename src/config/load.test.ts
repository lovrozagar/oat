import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { interpolate, loadConfig } from "./load.ts"

/*
 * `${NAME}` is filled from the environment through the plain data of a config. A value that is not
 * plain data — a file's bytes for an upload step, a date — is the config author's object and is
 * handed on as it is.
 */

describe("config env interpolation", () => {
	it("fills ${NAME} in strings inside objects and arrays", () => {
		expect(interpolate({ headers: { authorization: "Bearer ${TOKEN}" }, tags: ["${TOKEN}"] }, { TOKEN: "t" })).toEqual({
			headers: { authorization: "Bearer t" },
			tags: ["t"],
		})
	})

	it("hands on what is not plain data", () => {
		const bytes = new Uint8Array([1, 2, 3])
		const when = new Date(0)
		const config = interpolate({ scenarios: [{ steps: [{ body: bytes, when }] }] }, {})
		const step = config.scenarios[0]?.steps[0]
		expect(step?.body).toBe(bytes)
		expect(step?.when).toBe(when)
	})
})

describe("loading a config that reads an unset variable", () => {
	it("names the variable and the config file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-env-"))
		const path = join(dir, "oat.config.mjs")
		const envModule = join(import.meta.dirname, "env.ts")
		await writeFile(
			path,
			`import { env } from ${JSON.stringify(envModule)}\nexport default { token: env("OAT_UNSET_FOR_TEST") }\n`,
		)
		await expect(loadConfig(path)).rejects.toThrow(`oat: env OAT_UNSET_FOR_TEST is not set (${path})`)
	})
})
