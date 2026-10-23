import { describe, expect, it } from "vitest"
import { checkContext } from "../../../tests/support/check-context.ts"
import type { Client } from "../../client/client.ts"
import { fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import type { WriteContext } from "../checks/core/context.ts"
import { FindingCollector } from "../finding.ts"
import { me } from "./__fixtures__/me.ts"
import { selfIdentityCheck } from "./check.ts"

function contextFor(entityName: string, document = me()) {
	const model = modelOf(document)
	const { client, sent } = fakeClient(() => ({ status: 401 }))
	const ctx = checkContext<Client>({
		client,
		entityName,
		findings: new FindingCollector(),
		listOp: op(model, "me.get"),
		model,
	})
	return { ctx: ctx as WriteContext, model, sent }
}

describe("selfIdentityCheck", () => {
	it("plans for a self entity only", () => {
		expect(selfIdentityCheck.plan(contextFor("profile").ctx)).toEqual({ ok: true, value: undefined })
		const needs = { needs: "x-entity.identity: self, and a read or an update", ok: false }
		expect(selfIdentityCheck.plan(contextFor("nobody").ctx)).toEqual(needs)
		const notSelf = modelOf(me())
		const entity = notSelf.entities.get("profile")
		if (entity !== undefined) entity.identity = "id"
		expect(selfIdentityCheck.plan({ ...contextFor("profile").ctx, model: notSelf })).toEqual(needs)
	})

	it("runs against the entity in its context, and judges the caller's operations", async () => {
		const { ctx, model, sent } = contextFor("profile")
		expect(await selfIdentityCheck.run(ctx)).toMatchObject({ kind: "finding", verdict: "BACKEND_BUG" })
		expect(sent[0]?.path).toBe("/me")
		expect(selfIdentityCheck.subjects(model.entities.get("profile") as never, model)).toEqual(["me.get", "me.update"])
		expect(selfIdentityCheck).toMatchObject({ id: "auth.self-is-the-caller", mutates: true })
	})

	it("hands the run's own-record guard to the self check", async () => {
		const { ctx, sent } = contextFor("profile")
		const ownRecords = { disposable: async () => "d", identityOf: () => undefined, signIn: new Set<string>() }
		await selfIdentityCheck.run({ ...ctx, ownRecords })
		expect(sent[0]?.path).toBe("/me")
	})
})
