import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { runCheck } from "../../core/run.ts"
import { rankIsMonotonic } from "./auth-rank-is-monotonic.ts"
import { actor, caller, notesContext } from "./__fixtures__/context.ts"
import { notesDocument } from "./__fixtures__/notes.ts"

const model = modelOf(notesDocument())
const HOME = { org_id: "o1" }
const owner = actor("owner", { rank: 2, roots: HOME, role: "owner" })
const viewer = actor("viewer", { rank: 0, roots: HOME, role: "viewer" })
const member = actor("member", { rank: 1, roots: HOME })
const stranger = actor("stranger", { rank: 0, roots: { org_id: "o2" } })

/** Each credential's status for the read of note n1. */
const reads = (statuses: Record<string, number>) => (_method: string, _path: string, options: object) => ({
	status: statuses[caller(options) ?? ""] ?? 500,
})

describe("auth.rank-is-monotonic", () => {
	it("passes when every rank is served, and reads under each actor's own tenant", async () => {
		const { ctx, findings, sent } = notesContext(model, reads({ member: 200, owner: 200, viewer: 200 }), {
			actors: [owner, member, viewer, stranger],
		})
		expect(await runCheck(rankIsMonotonic, ctx)).toEqual({ kind: "asserted" })
		expect(sent.map((s) => `${caller(s.options)} ${s.path}`)).toEqual([
			"owner /orgs/o1/notes/n1",
			"member /orgs/o1/notes/n1",
			"viewer /orgs/o1/notes/n1",
		])
		expect(findings.findings).toEqual([])
	})

	it("passes when only the lower ranks are refused", async () => {
		const { ctx, findings } = notesContext(model, reads({ member: 404, owner: 200, viewer: 403 }), {
			actors: [owner, member, viewer],
		})
		expect(await runCheck(rankIsMonotonic, ctx)).toEqual({ kind: "asserted" })
		expect(findings.findings).toEqual([])
	})

	it("reports a lower rank served where a higher rank is denied", async () => {
		const { ctx, findings } = notesContext(model, reads({ member: 200, owner: 403, viewer: 200 }), {
			actors: [owner, member, viewer],
		})
		expect(await runCheck(rankIsMonotonic, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		const [finding] = findings.findings
		expect(finding?.summary).toBe("a lower-ranked role can read a record a higher-ranked role cannot")
		expect(finding?.detail).toContain("member (rank 1) was served note n1; owner (rank 2) was denied")
		expect(finding?.evidence.map((e) => e.status)).toEqual([200, 403])
	})

	it("names a role, else the principal, and does not call an error a denial", async () => {
		const { ctx, findings } = notesContext(model, reads({ member: 404, owner: 500, viewer: 200 }), {
			actors: [owner, member, viewer],
		})
		expect(await runCheck(rankIsMonotonic, ctx)).toEqual({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(findings.findings).toHaveLength(1)
		expect(findings.findings[0]?.detail).toContain("viewer (rank 0) was served note n1; member (rank 1) was denied")
	})

	it("stands down without a read, a record, principals, or two ranks in one tenant", () => {
		for (const fields of [
			{ actors: [owner, viewer], readOp: undefined },
			{ actors: [owner, viewer], records: [] },
			{ actors: [] },
			{ actors: [owner, stranger] },
			{ actors: [owner, actor("peer", { rank: 2, roots: HOME })] },
		]) {
			expect(rankIsMonotonic.plan(notesContext(model, reads({}), fields).ctx)).toEqual({ ok: false })
		}
		const { ctx } = notesContext(model, reads({}), { actors: [owner, viewer], records: [{ title: "x" }] })
		expect(rankIsMonotonic.plan(ctx)).toEqual({ needs: "a record that carries its identity", ok: false })
	})
})
