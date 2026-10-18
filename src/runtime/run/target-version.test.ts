import { describe, expect, it } from "vitest"
import { adoptPrincipals, resolvePrincipals } from "./principals.ts"
import { notesApi, notesDoc, optionsFor, planned } from "./__fixtures__/api.ts"
import { readVersion } from "./target-version.ts"
import type { RunOptions } from "./types.ts"

/* Which build the run tested, read once as the first principal, before anything is created. */

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
	return adoptPrincipals(run, (await resolvePrincipals(run)) ?? [])
}

describe("readVersion", () => {
	it("reads the build where the configuration says it is", async () => {
		const authed = await authedWith({ targetVersion: { from: "$.build", operationId: "meta.version" } })
		expect(await readVersion(authed)).toMatchObject({ value: "b-42" })
	})

	it("reads nothing when no version is configured", async () => {
		expect(await readVersion(await authedWith({}))).toBeUndefined()
	})
})
