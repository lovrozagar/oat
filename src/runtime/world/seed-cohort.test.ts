import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { RequestOptions } from "../../client/types.ts"
import { type Responder, fakeClient, modelOf, op } from "../checks/__fixtures__/harness.ts"
import { FixtureOverflow } from "../fixture.ts"
import { SeedError } from "../seed-error.ts"
import type { OpenApiDocument } from "../../spec/types.ts"
import { COUNTERS, type NotesOptions, notes, PAY } from "./__fixtures__/documents.ts"
import { seedCohort } from "./seed-cohort.ts"
import type { UploadContext } from "../upload.ts"
import type { WorldOptions } from "./types.ts"

const UPLOAD = {
	body: null,
	create: {
		requestBody: {
			content: {
				"multipart/form-data": {
					schema: {
						properties: { file: { contentMediaType: "application/pdf", format: "binary", type: "string" } },
						required: ["file"],
						type: "object",
					},
				},
			},
			required: true,
		},
	},
}

async function uploads(names: string[]): Promise<UploadContext> {
	const dir = await mkdtemp(join(tmpdir(), "oat-seed-each-"))
	for (const name of names) await writeFile(join(dir, name), `%PDF-1.1\n${name}\n%%EOF\n`)
	return { configDir: dir, seed: 1, uploads: { each: { "note.create": ["./*.pdf"] } } }
}

/* Creates succeed; the list already holds the only identity the schema allows. */
const onlyListed: Responder = (method) =>
	method === "POST" ? { status: 201 } : { body: [{ id: "only" }], status: 200 }

const scope = { projectId: "p1" }

const isDocument = (value: NotesOptions | OpenApiDocument): value is OpenApiDocument => "openapi" in value

/** The world's options, and the create the cohort is seeded through (default `note.create`). */
interface SeedSetup extends Partial<WorldOptions> {
	create?: string
}

function seed(
	respond: Responder,
	document: NotesOptions | OpenApiDocument = {},
	{ create = "note.create", ...options }: SeedSetup = {},
) {
	const model = modelOf(isDocument(document) ? document : notes(document))
	const fake = fakeClient(respond)
	const result = seedCohort(
		op(model, create),
		{ client: fake.client, model, options: { principal: "alpha", roots: scope, seed: 1, ...options } },
		{ created: [], values: scope },
	)
	return { result, sent: fake.sent }
}

const bodyOf = (options: Omit<RequestOptions, "as">): Record<string, unknown> => options.body as Record<string, unknown>

/* Creates echo what they were sent; the list is empty. */
const echo: Responder = (method, _path, options) =>
	method === "POST" ? { body: { ...bodyOf(options) }, status: 201 } : { body: [], status: 200 }

describe("seedCohort", () => {
	it("refuses a create that declares no request body", async () => {
		await expect(seed(echo, { body: null }).result).rejects.toThrow("note.create declares no request body")
	})

	it("creates the cohort and keeps the server's view of each record", async () => {
		const { result, sent } = seed(echo, {}, { cohortSize: 2, nonce: "n0" })
		const cohort = await result
		expect(cohort.records).toHaveLength(2)
		expect(cohort.members.map((member) => member.variant)).toEqual(["baseline", "lexical-first"])
		expect(sent.map((request) => request.method)).toEqual(["GET", "POST", "POST"])
	})

	it("reads the cohort without a list, and with a default size", async () => {
		const cohort = await seed(echo, { list: false }).result
		expect(cohort.records).toHaveLength(7)
	})

	it("names the operation when no body can be generated, a malformed schema included", async () => {
		const impossible = {
			properties: { n: { maximum: 1, minimum: 5, type: "integer" } },
			required: ["n"],
			type: "object",
		}
		await expect(seed(echo, { body: impossible }).result).rejects.toThrow(FixtureOverflow)
		await expect(seed(echo, { body: { allOf: [{ allOf: 5 }] } }).result).rejects.toThrow(
			/note\.create.*allOf\/0\/allOf is not a list of schemas/,
		)
	})
})

/* Withholds every create, as a lower rank's create of a body that requires a privileged property is. */
const barred = () => "note.create requires plan, marked x-privileged"

describe("seedCohort as a principal that must not send the create", () => {
	it("sends nothing and stops with the reason it is withheld", async () => {
		const { result, sent } = seed(echo, {}, { withheld: barred })
		await expect(result).rejects.toThrow(new SeedError("note.create", "note.create requires plan, marked x-privileged"))
		expect(sent).toEqual([])
	})
})

describe("seedCohort beside listed records", () => {
	it("adopts a listed record under a plan limit instead of inventing one", async () => {
		const { result, sent } = seed((method) =>
			method === "POST"
				? { body: { error: "payment_required" }, status: 402 }
				: { body: [{ id: 7 }, { id: "n1", name: "kept" }], status: 200 },
		)
		const seeded = await result
		expect(seeded.adopted).toBe(true)
		expect(seeded.records).toEqual([{ id: 7 }])
		expect(sent.map((request) => `${request.method} ${request.path}`)).toContain("POST /projects/p1/notes")
	})

	it("draws a client-chosen identity another tenant holds again and keeps the second record", async () => {
		const ids: unknown[] = []
		const { result } = seed(
			(method, _path, options) => {
				if (method !== "POST") return { body: [], status: 200 }
				ids.push(bodyOf(options)["id"])
				return ids.length === 1 ? { body: { error: "taken" }, status: 409 } : { body: bodyOf(options), status: 200 }
			},
			{},
			{ cohortSize: 1 },
		)
		const seeded = await result
		expect(ids).toHaveLength(2)
		expect(ids[1]).not.toEqual(ids[0])
		expect(seeded.records.map((record) => record["id"])).toEqual([ids[1]])
	})

	it("never sends an identity or a unique value a listed record already holds", async () => {
		const unique = { create: { "x-unique": [["name"]] } }
		const listed: Responder = (method, _path, options) =>
			method === "POST"
				? { body: bodyOf(options), status: 201 }
				: { body: [{ id: "Quarterly Report 0", name: "Quarterly Report 0" }], status: 200 }
		const { result, sent } = seed(listed, unique, { cohortSize: 1 })
		const seeded = await result
		expect(seeded.existingIds).toEqual(["Quarterly Report 0"])
		expect(bodyOf((sent[1] as { options: RequestOptions }).options)).not.toMatchObject({ name: "Quarterly Report 0" })
	})

	it("keeps a unique value apart from listed records when the body names no identity", async () => {
		const named = { properties: { name: { type: "string" } }, required: ["name"], type: "object" }
		const listed: Responder = (method, _path, options) =>
			method === "POST"
				? { body: { ...bodyOf(options), id: "n1" }, status: 201 }
				: { body: [{ id: "x", name: "Quarterly Report 0" }], status: 200 }
		const { result, sent } = seed(listed, { body: named, create: { "x-unique": [["name"]] } }, { cohortSize: 1 })
		await result
		expect(bodyOf((sent[1] as { options: RequestOptions }).options)["name"]).not.toBe("Quarterly Report 0")
	})
})

/* Every create refused with 409; the list holds one row another principal made. */
const refusing: Responder = (method) =>
	method === "POST" ? { body: { error: "taken" }, status: 409 } : { body: [{ id: "theirs" }], status: 200 }

describe("seedCohort refused for its client-chosen identity", () => {
	it("records the gap after three refused identities, adopting nothing and sending no fourth create", async () => {
		const { result, sent } = seed(refusing, { create: { "x-unique": [["name"]] } }, { cohortSize: 1 })
		const failed = await result.catch((error: unknown) => error)
		const posts = sent.filter((request) => request.method === "POST")
		const ids = posts.map((request) => String(bodyOf(request.options)["id"]))
		expect(posts).toHaveLength(3)
		expect(failed).toBeInstanceOf(SeedError)
		expect((failed as SeedError).message).toBe(
			`note.create: every client-chosen "id" sent was refused with 409 (${ids.join(", ")}); no fourth create was sent`,
		)
	})
})

describe("seedCohort with no entity identity", () => {
	it("seeds an entity with no identity of its own, and an operation no entity owns", async () => {
		const counters = await seed(
			(method) =>
				method === "POST" ? { body: { id: "c1", size: 1 }, status: 201 } : { body: [{ size: 3 }], status: 200 },
			COUNTERS,
			{ cohortSize: 1, create: "counter.create" },
		).result
		expect(counters).toMatchObject({ records: [{ id: "c1", size: 1 }] })
		expect(counters.existingIds).toBeUndefined()
		const unidentified: string[] = []
		const pay = await seed(
			(_method, _path, options) =>
				bodyOf(options)["size"] === 1 ? { body: { id: "p1" }, status: 200 } : { status: 200 },
			PAY,
			{ cohortSize: 2, create: "pay.start", onUnidentified: (entity) => unidentified.push(entity) },
		).result
		/* `{ id }` alone is not the record, and nothing reads it back: what was sent, unverified. */
		expect(pay).toMatchObject({ records: [{ flag: true, id: "p1", size: 1 }], unverified: true })
		expect(unidentified).toEqual(["pay.start"])
	})

	it("refuses when every generated identity names an existing record", async () => {
		const only = {
			properties: { id: { enum: ["only"], type: "string" }, name: { type: "string" } },
			required: ["id"],
			type: "object",
		}
		await expect(seed(onlyListed, { body: only }, { cohortSize: 1 }).result).rejects.toThrow(
			'every generated "id" names an existing record, so nothing was created',
		)
	})
})

describe("seedCohort losing variants", () => {
	it("says when unique values could not differ across variants", async () => {
		const fixed = {
			properties: { id: { type: "string" }, name: { enum: ["one"], type: "string" } },
			required: ["name"],
			type: "object",
		}
		const seeded = await seed(echo, { body: fixed, create: { "x-unique": [["name"]] } }, { cohortSize: 3 }).result
		expect(seeded.uniqueGap).toEqual(expect.any(String))
	})

	it("reports a variant the backend refused after the first, and skips one it cannot confirm", async () => {
		let posts = 0
		const { result } = seed(
			(method, _path, options) => {
				if (method !== "POST") return { body: [], status: 200 }
				posts += 1
				if (posts === 2) return { body: { error: "no" }, status: 422 }
				if (posts === 3) return { body: { ok: true }, status: 200 }
				return { body: bodyOf(options), status: 201 }
			},
			{ read: false },
			{ cohortSize: 4 },
		)
		const seeded = await result
		expect(seeded.failedVariants?.map((lost) => `${lost.variant} ${lost.exchange.status}`)).toEqual([
			"lexical-first 422",
		])
		expect(seeded.records).toHaveLength(2)
	})

	it("ends on the first create's refusal", async () => {
		const { result } = seed((method) =>
			method === "POST" ? { body: { error: "no" }, status: 400 } : { body: [], status: 200 },
		)
		await expect(result).rejects.toBeInstanceOf(SeedError)
	})

	it("returns the planned members when no record could be confirmed", async () => {
		const seeded = await seed(
			(method) => (method === "POST" ? { body: { ok: true }, status: 200 } : { body: [], status: 200 }),
			{
				read: false,
			},
			{ cohortSize: 2 },
		).result
		expect(seeded.records).toEqual([])
		expect(seeded.members).toHaveLength(2)
	})
})

describe("seeding one record per upload", () => {
	it("creates one record per file from the baseline member", async () => {
		const files = await uploads(["a.pdf", "b.pdf"])
		let id = 0
		const { result, sent } = seed(
			(method) => (method === "POST" ? { body: { id: `n${(id += 1)}` }, status: 201 } : { body: [], status: 200 }),
			UPLOAD,
			{ uploads: files },
		)
		const seeded = await result
		expect(seeded).toMatchObject({ records: [{ id: "n1" }, { id: "n2" }], unverified: true })
		expect(sent.filter((request) => request.method === "POST").map((request) => request.options.fixture)).toEqual([
			"a.pdf",
			"b.pdf",
		])
	})

	it("skips a file whose record it cannot confirm, and adopts or fails when none was made", async () => {
		const files = await uploads(["a.pdf"])
		const unconfirmed = await seed(
			(method) => (method === "POST" ? { body: { ok: true }, status: 201 } : { body: [], status: 200 }),
			{
				...UPLOAD,
				read: false,
			},
			{ uploads: files },
		).result
		expect(unconfirmed.records).toEqual([])
		const limited = await seed(
			(method) => (method === "POST" ? { status: 402 } : { body: [{ id: "n8" }], status: 200 }),
			UPLOAD,
			{ uploads: files },
		).result
		expect(limited).toMatchObject({ adopted: true, records: [{ id: "n8" }] })
	})

	it("sends an empty body when no member was planned", async () => {
		const files = await uploads(["a.pdf"])
		const seeded = await seed(
			(method) => (method === "POST" ? { body: { id: "n1" }, status: 201 } : { body: [], status: 200 }),
			UPLOAD,
			{
				cohortSize: 0,
				uploads: files,
			},
		).result
		expect(seeded.records).toEqual([{ id: "n1" }])
	})
})
