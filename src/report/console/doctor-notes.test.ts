import { describe, expect, it } from "vitest"
import { documentOf, listOp, modelOf, referenceModel } from "./__fixtures__/models.ts"
import type { QueryCatalog } from "./catalog.ts"
import { doctorFacts } from "./doctor-facts.ts"
import { authLines, catalogLines, envelopeLines, externalRefLines, gapLines } from "./doctor-notes.ts"

const empty = doctorFacts(modelOf(documentOf({})).model)

const row = (over: Partial<QueryCatalog> = {}): QueryCatalog => ({
	aliases: {},
	checks: [],
	entity: "note",
	filterable: [],
	harvest: [],
	hook: false,
	searchable: [],
	selectable: [],
	sortable: [],
	source: "heuristic",
	...over,
})

describe("catalogLines", () => {
	it("says nothing with no listable entity", () => {
		expect(catalogLines(empty)).toEqual([])
	})

	it("prints an undeclared catalog with dashes and no checks", () => {
		expect(catalogLines({ ...empty, catalogs: [row()] })).toEqual([
			"  query catalog (declared or skip — missing capability does not apply)",
			"    note  source=heuristic",
			"      filterable  —  ops implicit eq/neq/gt/gte/lt/lte/like",
			"      sortable    —",
			"      searchable  —",
			"      selectable  —",
			"      will apply  (none of the declared-or-skip catalog checks)",
			"",
		])
	})

	it("prints every declared capability, limit and grammar, and the checks they let run", () => {
		const full = row({
			checks: ["filter.empty-in", "search.empty-q"],
			emptyIn: "reject",
			filterable: [{ field: "a" }, { field: "b" }],
			grammar: "template {field}",
			harvest: ["filterableFrom", "sortableFrom"],
			hook: true,
			identityFilter: "id",
			maxFilterConditions: 4,
			maxInValues: 9,
			operators: ["eq", "in"],
			searchEmpty: "ignore",
			searchModes: ["plain", "phrase"],
			searchable: ["a"],
			select: { nested: false, unknown: "reject" },
			selectable: ["a", "b"],
			sort: { defaultOrder: "-a", maxKeys: 2, nulls: ["first", "last"], stableTiebreak: "id" },
			sortGrammar: "template {field}_{direction}",
			sortable: [{ field: "a" }],
			source: "mixed",
		})
		expect(catalogLines({ ...empty, catalogs: [full] }).slice(1, -1)).toEqual([
			"    note  source=mixed +hook harvest=filterableFrom,sortableFrom",
			"      grammar     template {field}",
			"      sort        template {field}_{direction}",
			"      filterable  a, b  ops eq,in",
			"      sortable    a",
			"      searchable  a",
			"      selectable  a, b",
			"      identityFilter=id  emptyIn=reject  maxInValues=9  maxFilterConditions=4  searchEmpty=ignore  " +
				"searchModes=plain,phrase  sort.nulls=first,last  sort.maxKeys=2  defaultOrder=-a  stableTiebreak=id  " +
				"select.unknown=reject  select.nested=false",
			"      will apply  filter.empty-in, search.empty-q",
		])
		const partial = row({ select: { nested: true }, sort: { maxKeys: 1 } })
		expect(catalogLines({ ...empty, catalogs: [partial] })).toContain("      sort.maxKeys=1  select.nested=true")
	})
})

describe("envelopeLines", () => {
	it("lists where each answer keeps its record and the id it made, sorted by operation", async () => {
		expect(envelopeLines((await referenceModel()).model)).toEqual([])
		const lines = envelopeLines((await referenceModel({ shape: "wrapped-records" })).model)
		expect(lines[0]).toBe("  record envelopes (x-entity.recordPath / createdIdFrom)")
		expect(lines).toContain(`    ${"table.create".padEnd(28)} record $.data  created id $.id`)
		expect(lines).toContain(`    ${"table.get".padEnd(28)} record $.data`)
		const ids = lines.slice(1, -1).map((line) => line.trim().split(" ")[0] ?? "")
		expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)))
		const idOnly = modelOf(
			documentOf({
				"/a": {
					get: listOp("a", "a.list"),
					post: {
						...(listOp("a", "a.create") as object),
						"x-entity": { action: "create", createdIdFrom: "$.id", name: "a" },
					},
				},
			}),
		).model
		expect(envelopeLines(idOnly)).toContain(`    ${"a.create".padEnd(28)} created id $.id`)
	})
})

describe("authLines", () => {
	it("names the recipes a secured document needs, and the overlay an unsecured one does", async () => {
		expect(authLines((await referenceModel()).model)).toEqual([])
		expect(authLines(modelOf(documentOf({})).model)).toEqual([
			"  auth",
			"    the document declares no security; add an overlay.",
			"",
		])
		const secured = modelOf(
			documentOf(
				{ "/a": { get: listOp("a", "a.list") } },
				{
					components: {
						securitySchemes: {
							bearer: { scheme: "bearer", type: "http" },
							key: { in: "header", name: "k", type: "apiKey" },
						},
					},
				},
			),
		).model
		expect(authLines(secured)).toEqual([
			"  auth",
			'    document declares "bearer", "key" but contains no',
			"    operation for obtaining a credential. No generic client can bootstrap from",
			"    this spec. Add a security.<scheme> recipe (login, static, mint, hook or oauth2)",
			"    to the config for each scheme the document declares.",
			"",
		])
	})
})

describe("externalRefLines", () => {
	it("lists the references oat did not follow", () => {
		expect(externalRefLines([])).toEqual([])
		expect(externalRefLines(["other.yaml#/a"])).toEqual([
			"  unresolved external $refs (not fetched — a test tool should not follow arbitrary URLs)",
			"    other.yaml#/a",
			"",
		])
	})
})

const gap = (tag: string, n: number) => ({ detail: `detail ${n}`, operationId: `op.${n}`, tag })

describe("gapLines", () => {
	it("lists gaps by tag, most frequent first, four per tag, with the remedy or a pointer to the README", () => {
		const gapsByTag = new Map([
			["operationId", [gap("operationId", 1)]],
			["x-entity", [1, 2, 3, 4, 5, 6].map((n) => gap("x-entity", n))],
		])
		expect(gapLines({ ...empty, gapsByTag })).toEqual([
			"  gaps by tag",
			"    x-entity (6) — name the entity and action so this operation joins a lifecycle",
			"      op.1: detail 1",
			"      op.2: detail 2",
			"      op.3: detail 3",
			"      op.4: detail 4",
			"      … and 2 more",
			"    operationId (1) — see the README",
			"      op.1: detail 1",
			"",
		])
		expect(gapLines(empty)).toEqual([])
	})

	it("reads the gaps a document really has", () => {
		const duplicated = modelOf(
			documentOf({ "/a": { get: listOp("a", "same.id") }, "/b": { get: listOp("b", "same.id") } }),
		).model
		expect(gapLines(doctorFacts(duplicated))).toContain("    operationId (1) — see the README")
	})
})
