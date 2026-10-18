import { describe, expect, it } from "vitest"
import { contextOf, notesApi, optionsFor } from "../__fixtures__/api.ts"
import { scopeReport } from "../result.ts"
import { graded, startedTest } from "./direct.ts"

describe("startedTest and graded", () => {
	it("marks the entity tested by its own check, and grades by how the check ended", async () => {
		const ctx = await contextOf(optionsFor(notesApi()))
		const note = ctx.model.entities.get("note")
		if (note === undefined) throw new Error("no note")
		startedTest(ctx, note, "self.identity")
		expect(ctx.state.entitiesTested).toEqual(["note"])
		expect(ctx.state.checksRun.has("self.identity")).toBe(true)
		expect(ctx.progress).toMatchObject({ check: "self.identity", entity: "note", phase: "test" })
		graded(ctx, ["notes.list"], "self.identity", { kind: "asserted" })
		graded(ctx, ["notes.get"], "self.identity", { kind: "stood-down", reason: "no read" })
		graded(ctx, ["notes.update"], "self.identity", { kind: "unresolved", reason: "refused" })
		const status = (id: string) => scopeReport(ctx).operations.find((op) => op.operationId === id)
		/* Graded, though nothing reached it in this test: the report says exactly that. */
		expect(status("notes.list")?.reason).toMatch(/^graded by checks, but no request/)
		expect(status("notes.get")?.reason).toBe("no check applied: needs no read")
		expect(status("notes.update")?.reason).toBe("no check applied: needs refused")
	})
})
