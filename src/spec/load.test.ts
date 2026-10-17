import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { loadSpec, pathTemplateMatches } from "./load.ts"

const DOC = { info: { title: "t", version: "1" }, openapi: "3.1.0", paths: {} }

async function file(name: string, text: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oat-load-"))
	const path = join(dir, name)
	await writeFile(path, text)
	return path
}

describe("loadSpec", () => {
	it("reads a file by path or file URL, JSON or YAML, past a byte-order mark", async () => {
		const json = await file("a.json", `﻿${JSON.stringify(DOC)}`)
		const yaml = await file("a.yaml", "openapi: 3.1.0\ninfo: { title: t, version: '1' }\npaths: {}\n")
		expect((await loadSpec(json)).openapi).toBe("3.1.0")
		expect((await loadSpec(pathToFileURL(yaml).toString())).openapi).toBe("3.1.0")
	})

	it("fetches a URL, and a route below the base URL, only through the caller's fetcher", async () => {
		const asked: string[] = []
		const fetchText = async (url: string): Promise<string> => {
			asked.push(url)
			return JSON.stringify(DOC)
		}
		await loadSpec("https://api.test/openapi.json", { fetchText })
		await loadSpec("v1/openapi", { baseUrl: "https://api.test/base", fetchText })
		expect(asked).toEqual(["https://api.test/openapi.json", "https://api.test/base/v1/openapi"])
		await expect(loadSpec("https://api.test/openapi.json")).rejects.toThrow("this caller reads only files")
	})

	it("tells a truncated document from a malformed one", async () => {
		const truncated = await file("t.json", '{"openapi": "3.1.0", "paths": {')
		const malformed = await file("m.json", '{"openapi": 3.1.0}')
		await expect(loadSpec(truncated)).rejects.toThrow(/most likely truncated/)
		await expect(loadSpec(malformed)).rejects.toThrow(/appears complete/)
	})

	it("names every place it looked when nothing is there", async () => {
		await expect(loadSpec("no/such/spec.json")).rejects.toThrow(/Pass --base-url/)
	})
})

describe("pathTemplateMatches", () => {
	it("matches one component per parameter, in either style", () => {
		expect(pathTemplateMatches("/v1/tables/{id}", "/v1/tables/t1")).toBe(true)
		expect(pathTemplateMatches("/v1/tables/:id", "/v1/tables/t1")).toBe(true)
		expect(pathTemplateMatches("/v1/tables/{id}", "/v1/tables/t1/rows")).toBe(false)
	})
})
