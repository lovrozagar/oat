import { describe, expect, it, vi } from "vitest"
import { DefectSet } from "../defects/defect-set.ts"
import type { EntityDef } from "../model/types.ts"
import type { SelectPlan } from "../query-types.ts"
import { MemoryStore } from "../stores/memory.ts"
import { BETA, rowsOf, TABLES } from "./__fixtures__/api.ts"
import { memoryStore } from "./engines.ts"
import { closeStore, createdIds, createReference, IN_PROCESS_ORIGIN, referenceState, snapshot } from "./reference.ts"
import { PRINCIPALS } from "./state.ts"

const JSON_TYPE = { "content-type": "application/json" }

/* Signs `key` in through the reference's own auth.token, and answers the headers that act as it. */
async function signedIn(send: typeof fetch, url: string, key = "key_alpha"): Promise<Record<string, string>> {
	const answer = await send(`${url}/v1/auth/token`, {
		body: JSON.stringify({ key }),
		headers: JSON_TYPE,
		method: "POST",
	})
	const { access_token: token } = (await answer.json()) as { access_token: string }
	return { ...JSON_TYPE, authorization: `Bearer ${token}` }
}

describe("createReference", () => {
	it("is a transport in process, at the shape's base URL", async () => {
		const reference = await createReference({ defects: ["STALE_LIST"], shape: "path-prefix" }, memoryStore)
		expect(reference.url).toBe(`${IN_PROCESS_ORIGIN}/api`)
		expect(reference.principals).toBe(PRINCIPALS)
		expect(reference.defects.list()).toEqual(["STALE_LIST"])
		const send = reference.fetch
		const created = await send(`${reference.url}${TABLES}`, {
			body: JSON.stringify({ name: "t" }),
			headers: await signedIn(send, reference.url),
			method: "POST",
		})
		expect(created.status).toBe(201)
		const { id } = (await created.json()) as { id: string }
		expect(reference.createdIds()).toEqual({ table: [id] })
		expect((await reference.snapshot()).table).toEqual([expect.objectContaining({ id, name: "t" })])
		await expect(reference.close()).resolves.toBeUndefined()
	})

	it("refuses an unknown dialect, shape or defect", async () => {
		await expect(createReference({ dialect: "nope" }, memoryStore)).rejects.toThrow(
			'unknown dialect "nope" — expected one of jsonapi, plain, classic, linked, postgrest, template',
		)
		await expect(createReference({ shape: "nope" }, memoryStore)).rejects.toThrow('unknown shape "nope"')
		await expect(createReference({ defects: ["NOPE"] }, memoryStore)).rejects.toThrow("unknown defect(s): NOPE")
	})
})

describe("referenceState", () => {
	it("defaults to the postgrest dialect, no shape and PATCH, and prepopulates before serving", async () => {
		const state = await referenceState({ shape: { prepopulate: 2 } }, memoryStore)
		expect([state.dialect.name, state.basePath, state.updateMethod, state.untagged]).toEqual([
			"postgrest",
			"",
			"PATCH",
			false,
		])
		expect(createdIds(state)).toEqual({})
		expect((await snapshot(state)).table).toHaveLength(3)
	})

	it("hands the store the defects and the shape's entities", async () => {
		const factory = vi.fn<(defects: DefectSet, entities: readonly EntityDef[]) => Promise<MemoryStore>>(
			async () => new MemoryStore(),
		)
		const state = await referenceState({ defects: ["FILTER_IGNORED"], shape: "uuid-ids", untagged: true }, factory)
		expect(factory).toHaveBeenCalledWith(state.defects, state.entities)
		expect(state.table.fields.find((field) => field.name === "id")?.format).toBe("uuid")
		expect(state.untagged).toBe(true)
	})
})

describe("the listing store under HIDDEN_FROM_CREATOR", () => {
	it("leaves hidden rows out of a select and passes everything else through", async () => {
		const tagged = Object.assign(new MemoryStore(), { label: "memory" })
		const state = await referenceState({ defects: ["HIDDEN_FROM_CREATOR"] }, async () => tagged)
		const row = state.entities.find((entity) => entity.name === "row") as EntityDef
		await state.listingStore.insert(row, { id: "r1", label: "oat-payload-probe", table_id: "t" })
		await state.listingStore.insert(row, { id: "r2", label: "shown", table_id: "t" })
		const all: SelectPlan = {
			collation: "binary",
			order: [],
			shuffleTies: false,
			where: { kind: "const", value: true },
		}
		expect((await state.listingStore.select(row, all)).map((r) => r.id)).toEqual(["r2"])
		expect((await state.store.select(row, all)).map((r) => r.id)).toEqual(["r1", "r2"])
		expect((state.listingStore as unknown as { label: string }).label).toBe("memory")
		expect(state.listingStore).not.toBe(state.store)
	})
})

describe("closeStore", () => {
	it("swallows a store that fails to close", async () => {
		const state = await referenceState({}, memoryStore)
		vi.spyOn(state.store, "close").mockRejectedValueOnce(new Error("busy"))
		await expect(closeStore(state)).resolves.toBeUndefined()
	})
})

describe("createdIds and snapshot", () => {
	it("ledger a table by its slug, once, and key every record by id", async () => {
		const reference = await createReference({ shape: "tenant-slugs" }, memoryStore)
		const send = reference.fetch
		const owners = {
			key_alpha: await signedIn(send, reference.url),
			key_beta: await signedIn(send, reference.url, BETA),
		}
		const post = (path: string, body: unknown, key: keyof typeof owners = "key_alpha") =>
			send(`${reference.url}${path}`, { body: JSON.stringify(body), headers: owners[key], method: "POST" })
		await post(TABLES, { name: "Plan A" })
		await post("/v1/projects/proj_beta/tables", { name: "Plan A" }, BETA)
		const row = (await (await post(rowsOf("plan-a"), { label: "r" })).json()) as { id: string }
		expect(reference.createdIds()).toEqual({ row: [row.id], table: ["plan-a"] })
		const tables = (await reference.snapshot()).table ?? []
		expect(tables.map((table) => table.id)).toEqual(["plan-a", "plan-a"])
	})

	it("ledger every API key the server issued, under api-key, whoever asked", async () => {
		const reference = await createReference({}, memoryStore)
		const send = reference.fetch
		const mint = async (key: string) => {
			const answer = await send(`${reference.url}/v1/api-keys`, {
				body: JSON.stringify({ scopes: [] }),
				headers: await signedIn(send, reference.url, key),
				method: "POST",
			})
			return ((await answer.json()) as { id: string }).id
		}
		const ids = [await mint("key_alpha"), await mint(BETA)]
		expect(reference.createdIds()).toEqual({ "api-key": ids })
	})

	it("key a renamed identity as id", async () => {
		const state = await referenceState({ shape: "wrapped-records" }, memoryStore)
		const tables = (await snapshot(state)).table ?? []
		expect(tables[0]).toMatchObject({ ID: 1, id: 1 })
		expect((await snapshot(state)).job?.[0]).not.toHaveProperty("ID")
	})
})
