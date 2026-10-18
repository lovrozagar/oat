import { describe, expect, it } from "vitest"
import { ENTITIES } from "../model/entities.ts"
import { JOB } from "../model/job.ts"
import { ROW } from "../model/row.ts"
import { TABLE } from "../model/table.ts"
import { matchRoute } from "./routes.ts"

describe("matchRoute", () => {
	it("matches a collection, with no item id", () => {
		expect(matchRoute("/v1/projects/p1/tables", ENTITIES)).toEqual({
			entity: TABLE,
			itemId: null,
			scope: { project_id: "p1" },
		})
	})

	it("matches an item, with its id and every parent", () => {
		expect(matchRoute("/v1/projects/p1/tables/t1/rows/r1", ENTITIES)).toEqual({
			entity: ROW,
			itemId: "r1",
			scope: { project_id: "p1", row_id: "r1", table_id: "t1" },
		})
		expect(matchRoute("/v1/projects/p1/jobs/j1", ENTITIES)?.entity).toBe(JOB)
	})

	it("decodes path parameters and ignores a trailing slash", () => {
		expect(matchRoute("/v1/projects/p%201/tables/", ENTITIES)?.scope).toEqual({ project_id: "p 1" })
	})

	it("answers null for a path no entity serves", () => {
		expect(matchRoute("/v1/projects/p1/widgets", ENTITIES)).toBeNull()
		expect(matchRoute("/v1/projects/p1", ENTITIES)).toBeNull()
		expect(matchRoute("/v2/projects/p1/tables", ENTITIES)).toBeNull()
	})

	it("answers a null item id when the item template does not name the parameter", () => {
		const odd = { ...TABLE, itemParam: "missing" }
		expect(matchRoute("/v1/projects/p1/tables/t1", [odd])?.itemId).toBeNull()
	})
})
