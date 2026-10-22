import { describe, expect, it } from "vitest"
import { packedManifests } from "../support/npm-pack.ts"

const manifest = { files: [{ path: "dist/cli.js" }] }

describe("packedManifests", () => {
	it("reads the manifests past a banner npm 10 prints before the JSON", () => {
		const stdout = `sync hooks: ✔️ (pre-commit, pre-push)\n${JSON.stringify([manifest], null, 2)}\n`
		expect(packedManifests(stdout)).toEqual([manifest])
	})

	it("reads npm 12's object keyed by package name", () => {
		expect(packedManifests(JSON.stringify({ "@lovrozagar/oat": manifest }))).toEqual([manifest])
	})

	it("names the start of what npm printed when there is no JSON in it", () => {
		expect(() => packedManifests("npm error code ENOENT\n")).toThrow(
			"npm pack printed no manifest JSON (no JSON in the output): npm error code ENOENT",
		)
		expect(() => packedManifests("[ not json")).toThrow(/npm pack printed no manifest JSON \(.+\): \[ not json/)
	})
})
