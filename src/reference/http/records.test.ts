import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import { api } from "./__fixtures__/api.ts"
import {
	answerCreated,
	answerRead,
	answerWritten,
	fieldList,
	hiddenFromCreator,
	present,
	replacementDefaults,
	skewForList,
	snapshotKey,
	tombstoned,
	withDefaults,
	wraps,
} from "./records.ts"

const PROBE = "oat-payload-probe"

describe("hiddenFromCreator", () => {
	it("hides a row holding the probe value, only under HIDDEN_FROM_CREATOR", () => {
		const hidden = new DefectSet(["HIDDEN_FROM_CREATOR"])
		expect(hiddenFromCreator(hidden, ROW, { label: PROBE })).toBe(true)
		expect(hiddenFromCreator(hidden, ROW, { label: "other" })).toBe(false)
		expect(hiddenFromCreator(hidden, TABLE, { name: PROBE })).toBe(false)
		expect(hiddenFromCreator(new DefectSet(), ROW, { label: PROBE })).toBe(false)
	})
})

describe("tombstoned", () => {
	it("is a soft-deleted record of an entity that soft-deletes", () => {
		expect(tombstoned(TABLE, { deleted_at: null })).toBe(false)
		expect(tombstoned(TABLE, { deleted_at: 5 })).toBe(true)
		expect(tombstoned(JOB, { deleted_at: 5 })).toBe(false)
	})
})

describe("present", () => {
	it("withholds write-only fields", async () => {
		const { state } = await api({ shape: "write-only-field" })
		expect(present(state, state.table, { id: "t", secret: "s" })).toEqual({ id: "t" })
	})

	it("adds internal fields under RESPONSE_SCHEMA_DRIFT", async () => {
		const { state } = await api({ defects: ["RESPONSE_SCHEMA_DRIFT"] })
		expect(present(state, state.table, { id: "t" })).toEqual({ _internal_revision: 7, _shard: "shard-a", id: "t" })
	})

	it("nests a related record under relatedRecord, keyed by the shape's identity", async () => {
		const wrapped = await api({ shape: "wrapped-records" })
		expect(present(wrapped.state, wrapped.state.table, { ID: 3 })).toEqual({ ID: 3, Status: { ID: 1, Name: "open" } })
		const plain = await api({ shape: { relatedRecord: true } })
		expect(present(plain.state, plain.state.table, { id: "t" })).toEqual({ Status: { id: 1, Name: "open" }, id: "t" })
	})
})

describe("skewForList", () => {
	it("rewrites a listed name only under LIST_DETAIL_DISAGREE", () => {
		const skew = new DefectSet(["LIST_DETAIL_DISAGREE"])
		expect(skewForList(skew, { name: "a" })).toEqual({ name: "a (listing)" })
		expect(skewForList(skew, { label: "a" })).toEqual({ label: "a" })
		expect(skewForList(new DefectSet(), { name: "a" })).toEqual({ name: "a" })
	})
})

describe("the record envelope", () => {
	it("wraps every answer but the job's under recordEnvelope", async () => {
		const { state } = await api({ shape: "wrapped-records" })
		const record = { ID: 4, name: "n" }
		expect(wraps(state, state.table)).toBe(true)
		expect(wraps(state, state.job)).toBe(false)
		expect(answerCreated(state, state.table, record)).toEqual({
			data: record,
			id: 4,
			message: "created",
			success: true,
		})
		expect(answerRead(state, state.table, record)).toEqual({ data: record, fields: fieldList(state.table) })
		expect(answerWritten(state, { entity: state.table, record }, "updated")).toEqual({
			id: 4,
			message: "updated",
			success: true,
		})
		expect(answerCreated(state, state.job, record)).toBe(record)
	})

	it("answers the bare record without it", async () => {
		const { state } = await api()
		const record = { id: "t" }
		expect(answerCreated(state, state.table, record)).toBe(record)
		expect(answerRead(state, state.table, record)).toBe(record)
		expect(answerWritten(state, { entity: state.table, record }, "deleted")).toBe(record)
	})

	it("lists the readable fields and their types", async () => {
		const { state } = await api({ shape: "write-only-field" })
		const listed = fieldList(state.table)
		expect(listed).toContainEqual({ name: "name", type: "string" })
		expect(listed.map((field) => field.name)).not.toContain("secret")
	})
})

describe("withDefaults", () => {
	it("issues an id, links the parents, stamps the times and fills every field", async () => {
		const { state } = await api()
		expect(withDefaults(state, { entity: state.table, scope: { project_id: "proj_alpha" } }, { name: "n" })).toEqual({
			created_at: 1_700_000_001_000,
			deleted_at: null,
			description: null,
			id: "table_000001",
			name: "n",
			position: 0,
			project_id: "proj_alpha",
			row_count: 0,
			slug: "",
			status: "active",
			updated_at: 1_700_000_001_000,
			verified: false,
		})
	})

	it("links only the parents a record stores, and a missing one as null", async () => {
		const { state } = await api()
		const row = withDefaults(state, { entity: ROW, scope: {} }, { label: "l" })
		expect(row).toMatchObject({ active: false, amount: 0, label: "l", note: null, table_id: null, tags: [] })
		expect(row).not.toHaveProperty("project_id")
	})

	it("pads a large record and derives a table's slug from its name", async () => {
		const large = await api({ shape: "large-pages" })
		const padded = withDefaults(large.state, { entity: large.state.table, scope: {} }, { name: "n" })
		expect(String(padded.padding).length).toBe(49_152)
		const slugs = await api({ shape: "tenant-slugs" })
		const named = withDefaults(slugs.state, { entity: slugs.state.table, scope: {} }, { name: "Quarterly Report 0" })
		expect(named.slug).toBe("quarterly-report-0")
		expect(slugs.state.slugOf.get(String(named.id))).toBe("quarterly-report-0")
		expect(withDefaults(slugs.state, { entity: slugs.state.table, scope: {} }, {}).slug).toBe("")
	})
})

describe("replacementDefaults and snapshotKey", () => {
	it("resets every writable field", () => {
		expect(replacementDefaults(TABLE)).toEqual({
			description: null,
			name: "",
			position: 0,
			slug: "",
			status: "active",
			verified: false,
		})
	})

	it("keys a snapshot by entity, project and table", () => {
		expect(snapshotKey(ROW, { project_id: "p", table_id: 3 })).toBe("row:p:3")
		expect(snapshotKey(TABLE, {})).toBe("table::")
	})
})
