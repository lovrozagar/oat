import { describe, expect, it } from "vitest"
import { buildModel } from "../../spec/graph/build.ts"
import { accountsDoc } from "../run/__fixtures__/accounts.ts"
import { modelOf } from "../../spec/graph/__fixtures__/operations.ts"
import { accountOps, makesAccount } from "./ops.ts"
import { OPEN } from "./__fixtures__/open.ts"

/* Which operations make an account, and which remove one: as itself, or by an admin, by id. */

describe("accountOps", () => {
	it("knows the signup makes an account, the delete-self removes one, and the member delete removes one by id", () => {
		const model = buildModel(accountsDoc({ adminDelete: true }))
		const ops = accountOps(model)
		expect([ops.creates("auth.signup"), ops.creates("notes.create"), ops.creates(undefined)]).toEqual([
			true,
			false,
			false,
		])
		expect(ops.deleteSelf?.operationId).toBe("me.delete")
		expect(ops.adminDelete("auth.signup")).toMatchObject({
			identity: "member_id",
			op: { operationId: "member.delete" },
		})
	})

	it("finds no admin delete for an operation of no entity, an entity with no delete, or the caller itself", () => {
		const ops = accountOps(buildModel(accountsDoc({ deleteSelf: false })))
		expect(ops.deleteSelf).toBeUndefined()
		expect(ops.adminDelete("auth.signup")).toBeUndefined()
		expect(ops.adminDelete("auth.login")).toBeUndefined()
		expect(ops.adminDelete("me.read")).toBeUndefined()
		expect(ops.adminDelete("nowhere")).toBeUndefined()
	})

	it("takes `id` as the identity of an entity that names none", () => {
		const model = buildModel(accountsDoc({ adminDelete: true }))
		const member = model.entities.get("member")
		if (member !== undefined) model.entities.set("member", { ...member, identity: null })
		expect(accountOps(model).adminDelete("auth.signup")?.identity).toBe("id")
	})

	it("counts an unmarked sign-up as making an account", () => {
		const model = modelOf({ "/v1/register": { post: { operationId: "auth.register", ...OPEN } } })
		expect(accountOps(model).creates("auth.register")).toBe(true)
	})

	it("counts a create of the caller's own record as making an account", () => {
		const model = buildModel(accountsDoc())
		const read = model.byOperationId.get("me.read")
		expect(read === undefined ? undefined : makesAccount({ ...read, action: "create" }, model)).toBe(true)
		expect(read === undefined ? undefined : makesAccount(read, model)).toBe(false)
	})
})
