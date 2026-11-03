import { describe, expect, it } from "vitest"
import { resolvePrincipals } from "./principals.ts"
import { notesApi, notesDoc, optionsFor, planned } from "./__fixtures__/api.ts"
import { readVersion } from "./target-version.ts"
import type { RunOptions } from "./types.ts"

/* Which build the run tested, read once as the writer, before anything is created. */

const versioned = notesDoc({
	"/version": { get: { operationId: "meta.version", responses: { "200": { description: "ok" } } } },
})

async function authedWith(extra: Partial<RunOptions>) {
	const notes = notesApi(versioned)
	const run = await planned(
		optionsFor(
			(method, path, request) =>
				path === "/version" ? { body: { build: "b-42" }, status: 200 } : notes(method, path, request),
			extra,
		),
	)
	const principals = await resolvePrincipals(run)
	if (principals === null) throw new Error("nobody signed in")
	return { ...run, principals }
}

describe("readVersion", () => {
	it("reads the build where the configuration says it is", async () => {
		const authed = await authedWith({ targetVersion: { from: "$.build", operationId: "meta.version" } })
		expect(await readVersion(authed)).toMatchObject({ value: "b-42" })
	})

	it("reads the build as the configured writer, not the first principal", async () => {
		const notes = notesApi(versioned)
		const options = optionsFor(
			(method, path, request) =>
				path === "/version" ? { body: { build: "b-42" }, status: 200 } : notes(method, path, request),
			{
				principals: { alpha: { email: "a@x.test" }, beta: { email: "b@x.test" } },
				security: { bearer: { static: "tok-{principal.email}" } },
				targetVersion: { from: "$.build", operationId: "meta.version" },
				writer: "beta",
			},
		)
		const run = await planned(options)
		const principals = await resolvePrincipals(run)
		if (principals === null) throw new Error("nobody signed in")
		expect(await readVersion({ ...run, principals })).toMatchObject({ value: "b-42" })
		const sentBy = options.seen.filter((request) => request.path === "/version")
		expect(sentBy.map((request) => request.headers["authorization"])).toEqual(["Bearer tok-b@x.test"])
	})

	it("reads nothing when no version is configured", async () => {
		expect(await readVersion(await authedWith({}))).toBeUndefined()
	})
})
