import { describe, expect, it } from "vitest"
import { itemModel, tablesModel } from "./__fixtures__/tables.ts"
import {
	bindAfterCreateEffects,
	bindCreatedScope,
	bindInstanceScope,
	bindMissingPathParams,
	canFillPath,
	identityPathParam,
	mergeScope,
} from "./scope.ts"

describe("identityPathParam", () => {
	it("is the last param of the entity's read, else its delete, else its update, else `{entity}_id`", () => {
		const model = tablesModel()
		expect(identityPathParam(model, "table")).toBe("table_id")
		expect(identityPathParam(model, "missing")).toBe("missing_id")
		expect(identityPathParam(itemModel("widget", "widget_id", ["delete"]), "widget")).toBe("widget_id")
		expect(identityPathParam(itemModel("note", "note_id", ["update"]), "note")).toBe("note_id")
		expect(identityPathParam(itemModel("tag", "tag_id", []), "tag")).toBe("tag_id")
		expect(identityPathParam(itemModel("item", "id", ["read"]), "item")).toBe("id")
	})
})

describe("bindCreatedScope / bindAfterCreateEffects", () => {
	it("binds table_id from the write body or the list delta", () => {
		const model = tablesModel()
		expect(bindCreatedScope(model, "table", { body: { table_id: "t_body" } })).toEqual({ table_id: "t_body" })
		expect(bindCreatedScope(model, "table", { body: { id: "t_id" } })).toEqual({ table_id: "t_id" })
		expect(bindCreatedScope(model, "table", { added: ["t_delta"], body: {} })).toEqual({ table_id: "t_delta" })
		expect(bindCreatedScope(model, "table", { body: {} })).toEqual({})
		expect(bindCreatedScope(model, "ghost", { body: { id: "g1" } })).toEqual({ ghost_id: "g1" })
		expect(bindCreatedScope(itemModel("item", "id", ["read"]), "item", { body: { id: "i1" } })).toEqual({
			id: "i1",
			item_id: "i1",
		})
	})

	it("binds only what a create effect made", () => {
		const effects = [
			{ entity: "table", op: "create" as const },
			{ entity: "row", min: 1, op: "append" as const },
		]
		expect(bindAfterCreateEffects(tablesModel(), effects, { body: { table_id: "t_new" } })).toEqual({
			table_id: "t_new",
		})
		expect(bindAfterCreateEffects(tablesModel(), effects, { body: {}, deltas: new Map([["table", ["t_d"]]]) })).toEqual(
			{
				table_id: "t_d",
			},
		)
	})
})

/* `bindInstanceScope` on the tables document's table. */
const bind = (identity: string, records: Record<string, unknown>[], scope: Record<string, string>) =>
	bindInstanceScope({ entityName: "table", identity, model: tablesModel(), records, scope })

describe("bindInstanceScope", () => {
	it("binds the seeded row's id when the path still needs it", () => {
		expect(bind("id", [{ id: "t_seed" }], { project_id: "p1" })).toEqual({ project_id: "p1", table_id: "t_seed" })
		expect(bind("id", [{ id: "t_seed" }], { project_id: "p1", table_id: "kept" })).toEqual({
			project_id: "p1",
			table_id: "kept",
		})
		expect(bind("missing", [{ id: "from-id" }], { project_id: "p1" })).toEqual({
			project_id: "p1",
			table_id: "from-id",
		})
		expect(bind("missing", [{ table_id: "from-param" }], { project_id: "p1" })).toEqual({
			project_id: "p1",
			table_id: "from-param",
		})
		expect(bind("id", [{}, { id: "t2" }], { project_id: "p1" })).toEqual({ project_id: "p1", table_id: "t2" })
		expect(bind("id", [{}], { project_id: "p1" })).toEqual({ project_id: "p1" })
	})
})

describe("bindMissingPathParams / mergeScope / canFillPath", () => {
	it("fills only what the scope lacks, once", () => {
		expect(bindMissingPathParams(["table_id", "table_id"], {}, { table_id: "t" })).toEqual({ table_id: "t" })
		expect(bindMissingPathParams(["project_id", "table_id"], { project_id: "p1" }, { table_id: "t9" })).toEqual({
			table_id: "t9",
		})
		expect(bindMissingPathParams(["project_id"], { project_id: "p1" }, { project_id: "other" })).toEqual({})
		expect(bindMissingPathParams(["table_id"], {}, { name: "n" })).toEqual({})
	})

	it("merges and checks a template fills", () => {
		expect(mergeScope({ project_id: "p1" }, { table_id: "t1" })).toEqual({ project_id: "p1", table_id: "t1" })
		expect(canFillPath("/v1/projects/{project_id}/tables/{table_id}/rows", { project_id: "p", table_id: "t" })).toBe(
			true,
		)
		expect(canFillPath("/v1/projects/{project_id}/tables/{table_id}/rows", { project_id: "p" })).toBe(false)
		expect(canFillPath("/v1/{ghost_id}", { project_id: "p1" })).toBe(false)
	})
})
