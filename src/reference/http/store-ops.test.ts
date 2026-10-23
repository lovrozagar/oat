import { afterEach, describe, expect, it, vi } from "vitest"
import { ROW } from "../model/row.ts"
import { api, BETA, rowsOf, TABLES } from "./__fixtures__/api.ts"
import {
	advanceJobs,
	assertUnique,
	liveRows,
	prepopulate,
	readModifyWrite,
	refreshParentCount,
	tableByKey,
	typedScope,
} from "./store-ops.ts"

afterEach(() => {
	vi.restoreAllMocks()
})

describe("typedScope", () => {
	it("reads each parameter as its entity's identity type", async () => {
		const { state } = await api({ shape: "integer-ids" })
		expect(await typedScope(state, { project_id: "proj_alpha", table_id: "7" })).toEqual({
			project_id: "proj_alpha",
			table_id: 7,
		})
		await expect(typedScope(state, { table_id: "x" })).rejects.toMatchObject({ status: 400 })
	})

	it("resolves a table slug to its id in the path's project", async () => {
		const slugs = await api({ shape: "tenant-slugs" })
		const table = await slugs.table("Q Report")
		expect(await typedScope(slugs.state, { project_id: "proj_alpha", table_id: "q-report" })).toEqual({
			project_id: "proj_alpha",
			table_id: table["id"],
		})
		expect(await typedScope(slugs.state, { table_id: "q-report" })).toEqual({ table_id: "table:missing:q-report" })
	})
})

describe("tableByKey", () => {
	it("reads the id itself without slugs", async () => {
		const { state } = await api()
		expect(await tableByKey(state, "proj_alpha", "t1")).toBe("t1")
	})

	it("prefers a live table to a deleted one holding the same slug", async () => {
		const slugs = await api({ shape: "tenant-slugs" })
		await slugs.table("Same")
		await slugs.call("DELETE", `${TABLES}/same`)
		const live = await slugs.table("Same")
		expect(await tableByKey(slugs.state, "proj_alpha", "same")).toBe(live["id"])
	})

	it("finds another project's slug only under FOREIGN_PARENT_ACCEPTED", async () => {
		const strict = await api({ shape: "tenant-slugs" })
		await strict.table("Theirs", BETA)
		expect(await tableByKey(strict.state, "proj_alpha", "theirs")).toBe("table:missing:theirs")
		const lax = await api({ defects: ["FOREIGN_PARENT_ACCEPTED"], shape: "tenant-slugs" })
		const theirs = await lax.table("Theirs", BETA)
		expect(await tableByKey(lax.state, "proj_alpha", "theirs")).toBe(theirs["id"])
	})
})

describe("liveRows", () => {
	it("ranges over one scope's live records, ignoring parameters the entity does not store", async () => {
		const { state, table, call } = await api()
		const kept = await table("kept")
		const gone = await table("gone")
		await table("theirs", BETA)
		await call("DELETE", `${TABLES}/${String(gone["id"])}`)
		const live = await liveRows(state, state.table, { project_id: "proj_alpha", table_id: "x", unset: undefined })
		expect(live.map((row) => row["id"])).toEqual([kept["id"]])
	})

	it("ranges over every record of an entity without soft delete", async () => {
		const { state, table, call } = await api()
		const parent = await table("t")
		await call("POST", rowsOf(parent["id"]), { body: { label: "a" } })
		expect(await liveRows(state, ROW, { table_id: parent["id"] })).toHaveLength(1)
	})
})

describe("assertUnique", () => {
	it("refuses a record that repeats a unique set in its scope, except itself", async () => {
		const { state, table } = await api()
		const first = await table("dup")
		const copy = { name: "dup", project_id: "proj_alpha" }
		await expect(assertUnique(state, { entity: state.table, record: copy })).rejects.toMatchObject({
			message: "unique constraint violated (name)",
			status: 409,
		})
		await expect(
			assertUnique(state, { entity: state.table, record: copy }, String(first["id"])),
		).resolves.toBeUndefined()
		await expect(
			assertUnique(state, { entity: state.table, record: { ...copy, project_id: "proj_beta" } }),
		).resolves.toBe(undefined)
	})

	it("checks nothing for an entity with no unique set, or under UNIQUE_NOT_ENFORCED", async () => {
		const { state } = await api()
		await expect(assertUnique(state, { entity: state.job, record: { name: "x" } })).resolves.toBeUndefined()
		const lax = await api({ defects: ["UNIQUE_NOT_ENFORCED"] })
		await lax.table("dup")
		await expect(
			assertUnique(lax.state, { entity: lax.state.table, record: { name: "dup", project_id: "proj_alpha" } }),
		).resolves.toBeUndefined()
	})

	it("keeps a slug unique within its project under tenant slugs", async () => {
		const slugs = await api({ shape: "tenant-slugs" })
		await slugs.table("Same")
		await expect(
			assertUnique(slugs.state, { entity: slugs.state.table, record: { project_id: "proj_alpha", slug: "same" } }),
		).rejects.toMatchObject({ message: "unique constraint violated (slug)" })
	})
})

describe("refreshParentCount", () => {
	it("keeps a table's row count current after a row write", async () => {
		const { state, table } = await api()
		const parent = await table("t")
		await state.store.insert(ROW, { id: "r1", label: "a", table_id: parent["id"] })
		await refreshParentCount(state, ROW, { table_id: String(parent["id"]) })
		expect((await state.store.byId(state.table, String(parent["id"])))?.["row_count"]).toBe(1)
	})

	it("touches nothing for another entity, a row without a table, or under PARENT_PROJECTION_STALE", async () => {
		const { state, table } = await api({ defects: ["PARENT_PROJECTION_STALE"] })
		const parent = await table("t")
		await state.store.insert(ROW, { id: "r1", label: "a", table_id: parent["id"] })
		await refreshParentCount(state, ROW, { table_id: String(parent["id"]) })
		const clean = await api()
		const update = vi.spyOn(clean.state.store, "update")
		await refreshParentCount(clean.state, clean.state.table, { table_id: "t" })
		await refreshParentCount(clean.state, ROW, {})
		expect(update).not.toHaveBeenCalled()
		expect((await state.store.byId(state.table, String(parent["id"])))?.["row_count"]).toBe(0)
	})
})

describe("readModifyWrite", () => {
	it("writes the whole record read before the patch", async () => {
		const { state, table } = await api()
		const made = await table("t")
		const updated = await readModifyWrite(state, { entity: state.table, id: String(made["id"]) }, { position: 9 })
		expect(updated).toMatchObject({ name: "t", position: 9 })
		expect(await readModifyWrite(state, { entity: state.table, id: "missing" }, { position: 1 })).toBeNull()
	})
})

describe("advanceJobs", () => {
	it("moves a started job from pending through running to complete", async () => {
		const { state, call } = await api()
		const now = vi.spyOn(Date, "now").mockReturnValue(1000)
		await call("POST", "/v1/projects/proj_alpha/jobs/start", { body: { name: "j" } })
		const [id] = [...state.jobStartedAt.keys()]
		const job = async () => state.store.byId(state.job, String(id))
		await advanceJobs(state)
		expect(await job()).toMatchObject({ progress: 0, status: "pending" })
		now.mockReturnValue(1030)
		await advanceJobs(state)
		expect(await job()).toMatchObject({ progress: 50, status: "running" })
		const update = vi.spyOn(state.store, "update")
		await advanceJobs(state)
		expect(update).not.toHaveBeenCalled()
		now.mockReturnValue(1100)
		await advanceJobs(state)
		expect(await job()).toMatchObject({ progress: 100, status: "complete" })
		expect(state.jobStartedAt.size).toBe(0)
	})

	it("forgets a job that is gone, and advances nothing under ASYNC_NEVER_COMPLETES", async () => {
		const { state } = await api()
		state.jobStartedAt.set("missing", 0)
		await advanceJobs(state)
		expect(state.jobStartedAt.size).toBe(0)
		const stuck = await api({ defects: ["ASYNC_NEVER_COMPLETES"] })
		await stuck.call("POST", "/v1/projects/proj_alpha/jobs/start", { body: { name: "j" } })
		vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER)
		await advanceJobs(stuck.state)
		expect(await stuck.state.store.byId(stuck.state.job, "job_000001")).toMatchObject({ status: "pending" })
	})
})

describe("prepopulate", () => {
	it("writes lived-in tables and finished jobs for both tenants", async () => {
		const { state } = await api()
		await prepopulate(state, 11)
		const tables = await liveRows(state, state.table, {})
		expect(tables.filter((row) => row["project_id"] === "proj_alpha")).toHaveLength(11)
		expect(tables.filter((row) => row["project_id"] === "proj_beta")).toHaveLength(2)
		expect(tables[0]).toMatchObject({ description: null, name: "apple 0000", position: 0, status: "active" })
		expect(tables[1]).toMatchObject({ description: "pre-existing banana record", name: "Banana 0001" })
		expect(tables.at(-1)).toMatchObject({ name: "Banana beta 0001", slug: "banana-beta-0001" })
		const jobs = await liveRows(state, state.job, {})
		expect(jobs.every((job) => job["status"] === "complete" && job["progress"] === 100)).toBe(true)
		expect(jobs.slice(0, 2).map((job) => job["note"])).toEqual([null, "Banana"])
	})
})
