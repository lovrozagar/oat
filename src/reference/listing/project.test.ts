import { describe, expect, it } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { DefectName } from "../defects/table.ts"
import { ROW } from "../model/row.ts"
import type { Row } from "../store-api.ts"
import { project } from "./project.ts"

const ROW_VALUE: Row = { id: "r1", label: "x", table_id: "t1" }
const embed = async (relation: string, row: Row): Promise<Row | null> =>
	row["table_id"] === undefined ? null : { name: `${relation}-name`, status: "active", secret: 1 }
/** What a fieldset is projected from: the sample row, with no defect and the embed on, unless given. */
interface Projecting {
	defects?: DefectName[]
	row?: Row
	withEmbed?: boolean
}
const projected = (select: string | undefined, { defects = [], row = ROW_VALUE, withEmbed = true }: Projecting = {}) =>
	project(row, { defects: new DefectSet(defects), embed: withEmbed ? embed : undefined, entity: ROW, select })

describe("project", () => {
	it("copies the whole row for no fieldset, or for any under the defect", async () => {
		const whole = await projected("*")
		expect(whole).toEqual(ROW_VALUE)
		expect(whole).not.toBe(ROW_VALUE)
		expect(await projected("id", { defects: ["SELECT_IGNORED"] })).toEqual(ROW_VALUE)
	})

	it("keeps the named fields the row has, in the order named", async () => {
		expect(await projected("label,missing,id")).toEqual({ id: "r1", label: "x" })
	})

	it("drops every named field but the identity under the defect", async () => {
		expect(await projected("label,id", { defects: ["SELECT_FIELD_MISSING"] })).toEqual({ id: "r1" })
	})

	it("embeds the named fields of a related record, or null where there is none", async () => {
		expect(await projected("id,table(name, nope)")).toEqual({ id: "r1", table: { name: "table-name" } })
		expect(await projected("table(name)", { row: { id: "r2" } })).toEqual({ table: null })
		expect(await projected("table(name)", { withEmbed: false })).toEqual({ table: null })
	})

	it("embeds the whole related record under the defect", async () => {
		expect(await projected("table(name)", { defects: ["NESTED_SELECT_IGNORED"] })).toEqual({
			table: { name: "table-name", secret: 1, status: "active" },
		})
	})
})
