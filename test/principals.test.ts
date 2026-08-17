import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	loadPersistedPrincipals,
	parsePersistedPrincipals,
	persistedToPrincipal,
	snapshotPrincipal,
} from "../src/runtime/principals.ts"

describe("persisted principals", () => {
	it("round-trips a snapshot", () => {
		const snap = snapshotPrincipal({
			headers: () => ({ authorization: "Bearer abc" }),
			id: "alpha",
			inviteAs: "beta@x.test",
			rank: 2,
			role: "owner",
			roots: { org_id: "org_1" },
		})
		expect(snap).toEqual({
			headers: { authorization: "Bearer abc" },
			id: "alpha",
			inviteAs: "beta@x.test",
			rank: 2,
			role: "owner",
			roots: { org_id: "org_1" },
		})
		expect(persistedToPrincipal(snap)).toEqual({
			headers: { authorization: "Bearer abc" },
			id: "alpha",
			inviteAs: "beta@x.test",
			rank: 2,
			role: "owner",
			roots: { org_id: "org_1" },
		})
	})

	it("omits empty optional fields", () => {
		expect(
			snapshotPrincipal({
				headers: () => ({}),
				id: "solo",
				roots: {},
			}),
		).toEqual({ headers: {}, id: "solo", roots: {} })
	})

	it("parses { principals } and a bare array", () => {
		const one = parsePersistedPrincipals(
			JSON.stringify({
				principals: [
					{
						headers: { authorization: "Bearer x", n: 1 },
						id: "a",
						inviteAs: "b@x.test",
						rank: 2,
						role: "owner",
						roots: { org_id: "1", skip: 9 },
					},
				],
			}),
		)
		expect(one[0]).toEqual({
			headers: { authorization: "Bearer x" },
			id: "a",
			inviteAs: "b@x.test",
			rank: 2,
			role: "owner",
			roots: { org_id: "1" },
		})
		const two = parsePersistedPrincipals(JSON.stringify([{ id: "b", headers: { k: "v" } }]))
		expect(two[0]?.headers).toEqual({ k: "v" })
	})

	it("skips unusable entries and keeps string maps only", () => {
		const parsed = parsePersistedPrincipals(
			JSON.stringify({
				principals: [
					null,
					{ id: 1 },
					{ id: "" },
					{ headers: "nope", id: "ok", inviteAs: 1, rank: "x", role: 2, roots: ["a"] },
				],
			}),
		)
		expect(parsed).toEqual([{ headers: {}, id: "ok", roots: {} }])
	})

	it("rejects invalid JSON, the wrong shape, and an empty list", () => {
		expect(() => parsePersistedPrincipals("{")).toThrow(/not valid JSON/)
		expect(() => parsePersistedPrincipals("{}")).toThrow(/must be/)
		expect(() => parsePersistedPrincipals("[]")).toThrow(/no usable principals/)
	})

	it("loads from disk and names a missing file", async () => {
		const dir = await mkdtemp(join(tmpdir(), "oat-pr-"))
		const path = join(dir, "principals.json")
		await writeFile(path, JSON.stringify({ principals: [{ id: "disk", headers: { a: "b" }, roots: {} }] }))
		const loaded = loadPersistedPrincipals(path)
		expect(loaded[0]?.id).toBe("disk")
		expect(() => loadPersistedPrincipals(join(dir, "missing.json"))).toThrow(/cannot read persisted principals/)
	})
})
