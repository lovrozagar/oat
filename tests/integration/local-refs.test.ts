import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../../src/runtime/run/index.ts"
import { Listeners, readJson, reply } from "../support/effects-fixtures.ts"

/*
 * A document split across files: `$ref`s into a sibling file, and from there into a third file and
 * back into the root. The run reads the schemas those files hold: it grades answers against them and
 * builds bodies from them.
 */

const listeners = new Listeners()
afterEach(() => listeners.closeAll())

/* The split fixture: pets.read answers a Pet from schemas/pet.yaml, whose tag is an enum in schemas/tag.yaml. */
const SPLIT = fileURLToPath(new URL("../../src/spec/load/__fixtures__/split/openapi.yaml", import.meta.url))
const PET_ID = "8d0c2a3e-0000-4000-8000-000000000001"

async function readPet(tag: string) {
	const paths: string[] = []
	const server = await listeners.listen((req, res) => {
		paths.push(req.url ?? "")
		reply(res, 200, { id: PET_ID, tag })
	})
	const result = await run({
		baseUrl: server.url,
		hooks: { resolvePathValue: () => Promise.resolve(PET_ID) },
		principals: { alpha: {} },
		seed: 1,
		spec: SPLIT,
	})
	return { paths, result }
}

describe("a response schema in another file", () => {
	it("passes an answer that holds to the schema two files away", async () => {
		const { paths, result } = await readPet("cat")
		expect(paths).toContain(`/pets/${PET_ID}`)
		expect(result.scope.operations.map((op) => [op.operationId, op.status])).toEqual([["pets.read", "passed"]])
		expect(result.findings).toEqual([])
	})

	it("fails an answer whose tag is outside the enum the third file declares", async () => {
		const { result } = await readPet("fish")
		expect(result.scope.operations.map((op) => [op.operationId, op.status])).toEqual([["pets.read", "failed"]])
		expect(result.findings).toContainEqual(
			expect.objectContaining({
				check: "response.contract-call",
				detail: expect.stringContaining("/tag must be equal to one of the allowed values"),
			}),
		)
	})
})

/* A root document whose create body and list item are `$ref`s into schemas/toy.yaml. */
const ROOT = `openapi: 3.1.0
info: { title: toys, version: "1" }
paths:
  /toys:
    post:
      operationId: toy.create
      x-entity: { action: create, identity: id, name: toy }
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "./schemas/toy.yaml#/NewToy" }
      responses:
        "201":
          description: created
          content:
            application/json:
              schema: { $ref: "./schemas/toy.yaml#/Toy" }
        "400": { description: invalid }
    get:
      operationId: toy.list
      x-entity: { action: list, identity: id, name: toy }
      responses:
        "200":
          description: every toy
          content:
            application/json:
              schema:
                type: object
                properties:
                  toys: { type: array, items: { $ref: "./schemas/toy.yaml#/Toy" } }
`

const TOY = `NewToy:
  type: object
  additionalProperties: false
  required: [name, kind]
  properties:
    name: { type: string, minLength: 1 }
    kind: { type: string, enum: [kite] }
Toy:
  type: object
  required: [id, name, kind]
  properties:
    id: { type: string }
    name: { $ref: "#/NewToy/properties/name" }
    kind: { $ref: "#/NewToy/properties/kind" }
`

/* The split toy document, written into a fresh temp directory. */
async function toyDocument(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "oat-local-refs-"))
	await mkdir(join(dir, "schemas"))
	await writeFile(join(dir, "openapi.yaml"), ROOT)
	await writeFile(join(dir, "schemas", "toy.yaml"), TOY)
	return join(dir, "openapi.yaml")
}

/* Stores a toy only when its body is a NewToy: a name, and the one kind the external file allows. */
async function toyServer(): Promise<{ bodies: unknown[]; url: string }> {
	const bodies: unknown[] = []
	const toys: Array<Record<string, unknown>> = []
	const server = await listeners.listen(async (req, res) => {
		if (req.method === "GET") return reply(res, 200, { toys })
		const body = await readJson<Record<string, unknown>>(req)
		bodies.push(body)
		const keys = Object.keys(body).sort().join()
		if (keys !== "kind,name" || body["kind"] !== "kite" || typeof body["name"] !== "string" || body["name"] === "") {
			return reply(res, 400, { error: "not a NewToy" })
		}
		const toy = { ...body, id: `toy_${toys.length + 1}` }
		toys.push(toy)
		return reply(res, 201, toy)
	})
	return { bodies, url: server.url }
}

describe("a request schema in another file", () => {
	it("builds create bodies from it, and the create the external schema allows passes", async () => {
		const spec = await toyDocument()
		const { bodies, url } = await toyServer()
		const result = await run({ baseUrl: url, principals: { alpha: {} }, seed: 1, spec })
		expect(result.scope.operations.find((op) => op.operationId === "toy.create")?.status).toBe("passed")
		const created = result.client.transcript.filter((e) => e.operationId === "toy.create" && e.status === 201)
		expect(created.length).toBeGreaterThan(0)
		expect(created.every((e) => (e.requestBody as { kind?: string }).kind === "kite")).toBe(true)
		expect(bodies.length).toBeGreaterThanOrEqual(created.length)
	})
})
