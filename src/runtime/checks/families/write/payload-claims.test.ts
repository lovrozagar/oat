import { describe, expect, it } from "vitest"
import { modelOf } from "../../__fixtures__/harness.ts"
import { plannedWritePath } from "./payload-cases.ts"
import { PayloadClaims } from "./payload-claims.ts"
import { WIDGET, widgetDoc } from "./__fixtures__/widget-api.ts"

const path = 'application/json|["string",null]'

/* Resolves after every promise callback already queued has run. */
const drained = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("PayloadClaims", () => {
	it("gives the path to the entity planned first, even when it arrives last", async () => {
		const claims = new PayloadClaims()
		claims.plan([
			{ entity: "a", path },
			{ entity: "b", path },
		])
		const later = claims.claim("b", path)
		let answered = false
		void later.then(() => {
			answered = true
		})
		await drained()
		expect(answered).toBe(false)
		expect(await claims.claim("a", path)).toBeNull()
		expect(await later).toBe("a")
	})

	it("passes the path on when the entity planned first finishes without the catalog", async () => {
		const claims = new PayloadClaims()
		claims.plan([
			{ entity: "a", path },
			{ entity: "b", path },
			{ entity: "c", path },
		])
		const c = claims.claim("c", path)
		const b = claims.claim("b", path)
		claims.settle("a")
		expect(await b).toBeNull()
		expect(await c).toBe("b")
	})

	it("waits on no entity planned on another path or none, and none at all for an entity outside the plan", async () => {
		const claims = new PayloadClaims()
		claims.plan([
			{ entity: "a", path: '|["string",null]' },
			{ entity: "b", path: null },
			{ entity: "c", path },
		])
		expect(await claims.claim("c", path)).toBeNull()
		expect(await claims.claim("d", path)).toBeNull()
	})
})

describe("plannedWritePath", () => {
	it("keys the field the payload check would probe, and has none for an entity it cannot run on", () => {
		const model = modelOf(widgetDoc())
		const [widget] = [...model.entities.values()]
		if (widget === undefined) throw new Error("the widget document has an entity")
		/* The widget's note: a nullable string, the field the check picks. */
		expect(plannedWritePath(model, widget)).toBe('application/json|[["string","null"],null]')
		/* An identity the document leaves undeclared is `id`, which is not probed either. */
		expect(plannedWritePath(model, { ...widget, identity: null })).toBe('application/json|[["string","null"],null]')
		const { delete: _delete, read: _read, update: _update, ...routes } = widget
		/* Neither an update nor a delete, or no item read: the check has nothing to run on. */
		expect(plannedWritePath(model, { ...routes, read: widget.read ?? "" })).toBeNull()
		expect(
			plannedWritePath(model, { ...routes, ...(widget.update === undefined ? {} : { update: widget.update }) }),
		).toBeNull()
	})

	it("has none for an entity with no free string to probe", () => {
		const model = modelOf(widgetDoc({ item: { ...WIDGET, properties: { id: { readOnly: true, type: "string" } } } }))
		const [widget] = [...model.entities.values()]
		if (widget === undefined) throw new Error("the widget document has an entity")
		expect(plannedWritePath(model, widget)).toBeNull()
	})
})
