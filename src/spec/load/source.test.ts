import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { loadSpec } from "./source.ts"

const DOC = { info: { title: "t", version: "1" }, openapi: "3.1.0", paths: {} }

async function file(name: string, text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oat-load-"))
	const path = join(dir, name)
	await writeFile(path, text)
	return path
}

describe("loadSpec", () => {
	it("reads a file by absolute or relative path, or by file URL", async () => {
		const json = await file("a.json", JSON.stringify(DOC))
		const yaml = await file("a.yaml", "openapi: 3.1.0\ninfo: { title: t, version: '1' }\npaths: {}\n")
		expect((await loadSpec(json)).openapi).toBe("3.1.0")
		expect((await loadSpec(relative(process.cwd(), json))).openapi).toBe("3.1.0")
		expect((await loadSpec(pathToFileURL(yaml).toString())).openapi).toBe("3.1.0")
	})

	it("fetches a URL, and a route below the base URL, only through the caller's fetcher", async () => {
		const asked: string[] = []
		const fetchText = async (url: string): Promise<string> => {
			asked.push(url)
			return JSON.stringify(DOC)
		}
		await loadSpec("https://api.test/openapi.json", { fetchText })
		await loadSpec("http://api.test/openapi.json", { fetchText })
		await loadSpec("v1/openapi", { baseUrl: "https://api.test/base", fetchText })
		await loadSpec("v1/openapi", { baseUrl: "https://api.test/base/", fetchText })
		expect(asked).toEqual([
			"https://api.test/openapi.json",
			"http://api.test/openapi.json",
			"https://api.test/base/v1/openapi",
			"https://api.test/base/v1/openapi",
		])
		await expect(loadSpec("https://api.test/openapi.json")).rejects.toThrow(
			"oat: https://api.test/openapi.json is a URL, and this caller reads only files",
		)
		await expect(loadSpec("v1/openapi", { baseUrl: "https://api.test" })).rejects.toThrow(
			"this caller reads only files",
		)
	})

	it("names the place it looked when nothing is there, and how to resolve a route", async () => {
		const missing = join(tmpdir(), "oat-no-such", "spec.json")
		await expect(loadSpec(missing)).rejects.toThrow(
			`oat: could not find a specification at "${missing}". Tried:\n  ${missing}\nPass --base-url`,
		)
		await expect(loadSpec(missing, { baseUrl: "" })).rejects.toThrow(new RegExp(`Tried:\\n  ${missing}$`))
	})

	it("passes on a read failure other than a missing file", async () => {
		await expect(loadSpec(tmpdir())).rejects.toMatchObject({ code: "EISDIR" })
	})
})
