import { describe, expect, it } from "vitest"
import { ENTITIES } from "./entities.ts"
import { JOB } from "./job.ts"
import { ROW } from "./row.ts"
import { TABLE } from "./table.ts"
import { WEBHOOK } from "./webhook.ts"

describe("ENTITIES", () => {
	it("lists every entity, a parent before its children", () => {
		expect(ENTITIES).toEqual([TABLE, ROW, JOB, WEBHOOK])
		expect(ENTITIES[0]).toBe(TABLE)
	})

	it("gives each entity its own item parameter", () => {
		expect(new Set(ENTITIES.map((entity) => entity.itemParam)).size).toBe(ENTITIES.length)
	})
})
