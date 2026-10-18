import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
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

/* A config file named `name` holding `text`, in a fresh folder. */
async function written(name: string, text: string): Promise<string> {
	const path = join(await mkdtemp(join(tmpdir(), "oat-load-")), name)
	await writeFile(path, text)
	return path
}

describe("loadConfig", () => {
	it("reads a JSON config, from a path relative to the working directory", async () => {
		const path = await written("oat.config.json", '{"spec":"openapi.json"}')
		expect(await loadConfig(relative(process.cwd(), path))).toEqual({ spec: "openapi.json" })
	})

	it("takes a module's default export, or the module itself when it has none", async () => {
		expect(await loadConfig(await written("a.mjs", 'export default { spec: "a.json" }\n'))).toEqual({ spec: "a.json" })
		expect(await loadConfig(await written("b.mjs", 'export const spec = "b.json"\n'))).toMatchObject({ spec: "b.json" })
	})

	it("refuses a default export that is not a config object", async () => {
		const path = await written("c.mjs", "export default 5\n")
		await expect(loadConfig(path)).rejects.toThrow(
			`oat: failed to load config ${path}: config module has no default export`,
		)
	})

	it("names what a module threw, an Error or not", async () => {
		const thrown = await written("d.mjs", 'throw "boom"\n')
		await expect(loadConfig(thrown)).rejects.toThrow(`oat: failed to load config ${thrown}: boom`)
		const failing = await written("e.ts", 'throw new Error("bad value")\n')
		await expect(loadConfig(failing)).rejects.toThrow(`oat: failed to load config ${failing}: bad value`)
	})

	it("says how to load TypeScript when the runtime cannot import it", async () => {
		/* What Node without type stripping raises for a .ts import. */
		const path = await written(
			"f.ts",
			'throw new TypeError(`Unknown file extension ".ts" for ${import.meta.filename}`)\n',
		)
		await expect(loadConfig(path)).rejects.toThrow(
			`oat: cannot load ${path} — this Node build will not import TypeScript directly. ` +
				"Run with `node --experimental-strip-types`, or use a .js/.mjs config.",
		)
		const mjs = await written("g.mjs", 'throw new TypeError("Unknown file extension")\n')
		await expect(loadConfig(mjs)).rejects.toThrow(`oat: failed to load config ${mjs}: Unknown file extension`)
	})
})

describe("interpolate", () => {
	it("names a variable the environment lacks, and hands on a scalar", () => {
		expect(() => interpolate({ token: "${OAT_MISSING}" }, {})).toThrow(
			"oat: config references ${OAT_MISSING}, which is not set in the environment",
		)
		expect(interpolate(7)).toBe(7)
	})
})
