import { describe, expect, it } from "vitest"
import { ROW } from "../model/row.ts"
import { api, BETA, rowsOf, TABLES } from "./__fixtures__/api.ts"
import { assertParents, assertTenant, assertWrite, bearer, findItem, ownedByTenant, underPath } from "./access.ts"
import { PRINCIPALS } from "./state.ts"
import { referenceRequest } from "./wire.ts"

const [OWNER, OTHER, MEMBER, VIEWER] = PRINCIPALS as [
	(typeof PRINCIPALS)[0],
	(typeof PRINCIPALS)[0],
	(typeof PRINCIPALS)[0],
	(typeof PRINCIPALS)[0],
]
const ALPHA = { project_id: "proj_alpha" }

/* A row under one of alpha's tables, and the scope that names it. */
async function rowWorld(options = {}) {
	const world = await api(options)
	const table = await world.table("t")
	const row = (await world.call("POST", rowsOf(table.id), { body: { label: "r" } })).body
	return { ...world, row, rowScope: { ...ALPHA, table_id: String(table.id) }, tableId: String(table.id) }
}

const request = (authorization?: string) =>
	referenceRequest("GET", new URL("http://reference.test/"), {
		headers: authorization === undefined ? {} : { authorization },
		read: async () => "",
	})

describe("bearer", () => {
	it("reads a bearer token, and nothing else", () => {
		expect(bearer(request("Bearer  tok "))).toBe("tok")
		expect(bearer(request("Basic abc"))).toBeUndefined()
		expect(bearer(request())).toBeUndefined()
	})
})

describe("assertWrite", () => {
	it("lets the owner do everything, the member write but not delete, the viewer nothing", async () => {
		const { state } = await api()
		const allowed = (principal: typeof OWNER, kind: "create" | "update" | "delete") => {
			try {
				assertWrite(state, principal, kind)
				return true
			} catch {
				return false
			}
		}
		const kinds = ["create", "update", "delete"] as const
		expect([OWNER, MEMBER, VIEWER].map((p) => kinds.map((kind) => allowed(p, kind)))).toEqual([
			[true, true, true],
			[true, true, false],
			[false, false, false],
		])
	})

	it("lets every rank do everything under ROLE_NOT_CHECKED", async () => {
		const { state } = await api({ defects: ["ROLE_NOT_CHECKED"] })
		for (const kind of ["create", "update", "delete"] as const) {
			expect(() => assertWrite(state, VIEWER, kind)).not.toThrow()
		}
	})

	it("turns the lattice over for updates under ROLE_WRITE_INVERTED", async () => {
		const { state } = await api({ defects: ["ROLE_WRITE_INVERTED"] })
		expect(() => assertWrite(state, VIEWER, "update")).not.toThrow()
		expect(() => assertWrite(state, MEMBER, "update")).toThrow("role cannot write")
		expect(() => assertWrite(state, OWNER, "update")).not.toThrow()
		expect(() => assertWrite(state, VIEWER, "create")).toThrow("role cannot write")
	})
})

describe("assertTenant", () => {
	it("refuses another tenant's project with a 403", () => {
		expect(() => assertTenant(OWNER, undefined)).not.toThrow()
		expect(() => assertTenant(OWNER, "proj_alpha")).not.toThrow()
		expect(() => assertTenant(OWNER, "proj_beta")).toThrow(expect.objectContaining({ status: 403 }))
	})
})

describe("ownedByTenant", () => {
	it("reads the tenant field, or walks up to the parent that has one", async () => {
		const { state, row } = await rowWorld()
		expect(await ownedByTenant(state, { entity: state.table, record: { project_id: "proj_alpha" } }, OWNER)).toBe(true)
		expect(await ownedByTenant(state, { entity: state.table, record: { project_id: "proj_alpha" } }, OTHER)).toBe(false)
		expect(await ownedByTenant(state, { entity: ROW, record: row }, OWNER)).toBe(true)
		expect(await ownedByTenant(state, { entity: ROW, record: row }, OTHER)).toBe(false)
	})

	it("owns nothing for a record with no link, or a link to nothing", async () => {
		const { state } = await api()
		expect(await ownedByTenant(state, { entity: ROW, record: { table_id: null } }, OWNER)).toBe(false)
		expect(await ownedByTenant(state, { entity: ROW, record: { table_id: "missing" } }, OWNER)).toBe(false)
		expect(await ownedByTenant(state, { entity: ROW, record: { table_id: 4 } }, OWNER)).toBe(false)
	})
})

describe("assertParents", () => {
	it("admits the caller's own live parents", async () => {
		const { state, rowScope } = await rowWorld()
		await expect(assertParents(state, { entity: ROW, principal: OWNER, scope: rowScope })).resolves.toBeUndefined()
	})

	it("refuses a missing, deleted, foreign or misplaced parent with a 404", async () => {
		const { state, call, table, tableId, rowScope } = await rowWorld()
		const theirs = await table("theirs", BETA)
		const refused = (scope: Record<string, string>) => assertParents(state, { entity: ROW, principal: OWNER, scope })
		await expect(refused({ ...ALPHA, table_id: "missing" })).rejects.toMatchObject({ status: 404 })
		await expect(refused(ALPHA)).rejects.toMatchObject({ message: "table  does not exist" })
		await expect(refused({ ...ALPHA, table_id: String(theirs.id) })).rejects.toMatchObject({ status: 404 })
		await expect(refused({ project_id: "proj_beta", table_id: tableId })).rejects.toMatchObject({ status: 404 })
		await call("DELETE", `${TABLES}/${tableId}`)
		await expect(refused(rowScope)).rejects.toMatchObject({ status: 404 })
	})

	it("admits any existing parent under FOREIGN_PARENT_ACCEPTED", async () => {
		const { state, table } = await api({ defects: ["FOREIGN_PARENT_ACCEPTED"] })
		const theirs = await table("theirs", BETA)
		const admitted = (scope: Record<string, string>) => assertParents(state, { entity: ROW, principal: OWNER, scope })
		await expect(admitted({ ...ALPHA, table_id: String(theirs.id) })).resolves.toBeUndefined()
		await expect(admitted({ ...ALPHA, table_id: "missing" })).rejects.toMatchObject({
			status: 404,
		})
	})
})

describe("underPath", () => {
	it("serves a record only under the path that names its own parents", async () => {
		const { state, row, rowScope, table } = await rowWorld()
		expect(await underPath(state, { entity: ROW, record: row }, rowScope)).toBe(true)
		expect(await underPath(state, { entity: ROW, record: row }, { ...rowScope, project_id: "proj_beta" })).toBe(false)
		const other = await table("other")
		expect(await underPath(state, { entity: ROW, record: row }, { ...rowScope, table_id: String(other.id) })).toBe(
			false,
		)
		expect(
			await underPath(state, { entity: ROW, record: { ...row, table_id: "missing" } }, { project_id: "proj_alpha" }),
		).toBe(false)
	})

	it("stops at a parent the record does not store", async () => {
		const { state, row } = await rowWorld()
		const unlinked = { ...ROW, fields: ROW.fields.filter((field) => field.name !== "table_id") }
		expect(await underPath(state, { entity: unlinked, record: row }, { project_id: "proj_beta" })).toBe(true)
	})
})

describe("findItem", () => {
	it("finds the caller's own record, and refuses a missing or deleted one with a 404", async () => {
		const { state, call, table } = await api()
		const made = await table("t")
		const target = { entity: state.table, itemId: String(made.id), principal: OWNER, scope: ALPHA }
		expect(await findItem(state, target)).toMatchObject({ name: "t" })
		await expect(findItem(state, { ...target, itemId: "missing" })).rejects.toMatchObject({
			message: "table missing does not exist",
			status: 404,
		})
		await call("DELETE", `${TABLES}/${String(made.id)}`)
		await expect(findItem(state, target)).rejects.toMatchObject({ message: /has been deleted/, status: 404 })
	})

	it("hides another tenant's record behind a 404, or a 403 under EXISTENCE_LEAK_VIA_STATUS", async () => {
		const clean = await api()
		const theirs = await clean.table("theirs", BETA)
		const target = {
			entity: clean.state.table,
			itemId: String(theirs.id),
			principal: OWNER,
			scope: { project_id: "proj_beta" },
		}
		await expect(findItem(clean.state, target)).rejects.toMatchObject({ status: 404 })
		const leaky = await api({ defects: ["EXISTENCE_LEAK_VIA_STATUS"] })
		await leaky.table("theirs", BETA)
		await expect(findItem(leaky.state, target)).rejects.toMatchObject({ status: 403 })
	})

	it("serves another tenant's record under CROSS_TENANT_READ, and for writing under CROSS_TENANT_WRITE", async () => {
		const reads = await api({ defects: ["CROSS_TENANT_READ"] })
		const theirs = await reads.table("theirs", BETA)
		const target = { entity: reads.state.table, itemId: String(theirs.id), principal: OWNER, scope: ALPHA }
		expect(await findItem(reads.state, target)).toMatchObject({ name: "theirs" })
		const writes = await api({ defects: ["CROSS_TENANT_WRITE"] })
		await writes.table("theirs", BETA)
		expect(await findItem(writes.state, target, "write")).toMatchObject({ name: "theirs" })
		await expect(findItem(writes.state, target)).rejects.toMatchObject({ status: 404 })
	})
})

describe("findItem through a grant", () => {
	it("serves a record through an accepted grant, unless INVITE_NEVER_GRANTS", async () => {
		for (const [defects, served] of [
			[[], true],
			[["INVITE_NEVER_GRANTS"], false],
		] as const) {
			const world = await api({ defects: [...defects] })
			const theirs = await world.table("shared", BETA)
			const grant = { accepted: false, entity: "table", granteeKey: "key_alpha", resourceId: String(theirs.id) }
			world.state.grants.set("g", { ...grant, grantId: "g", token: "t" })
			const target = {
				entity: world.state.table,
				itemId: String(theirs.id),
				principal: OWNER,
				scope: { project_id: "proj_beta" },
			}
			await expect(findItem(world.state, target)).rejects.toMatchObject({ status: 404 })
			world.state.grants.set("g", { ...grant, accepted: true, grantId: "g", token: "t" })
			const found = await findItem(world.state, target).then(
				() => true,
				() => false,
			)
			expect(found).toBe(served)
		}
	})

	it("hides a row holding the probe value from its creator", async () => {
		const { state, rowScope, tableId, call } = await rowWorld({ defects: ["HIDDEN_FROM_CREATOR"] })
		const probe = (await call("POST", rowsOf(tableId), { body: { label: "oat-payload-probe" } })).body
		await expect(
			findItem(state, { entity: ROW, itemId: String(probe.id), principal: OWNER, scope: rowScope }),
		).rejects.toMatchObject({
			status: 404,
		})
	})
})
