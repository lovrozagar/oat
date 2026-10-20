import { describe, expect, it } from "vitest"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import { Client } from "../../src/client/client.ts"
import { createCredentialSource } from "../../src/client/credentials.ts"
import type { PrincipalsConfig, SecurityConfig } from "../../src/config/types/security.ts"
import type { CredentialPorts } from "../../src/credentials/ports.ts"
import { createStore } from "../../src/credentials/store.ts"
import { resolvePathScope } from "../../src/runtime/world/path-scope.ts"
import { buildModel } from "../../src/spec/graph/build.ts"
import { dereference } from "../../src/spec/load/dereference.ts"
import { operationResolver } from "../../src/spec/graph/resolver.ts"
import type { SpecModel } from "../../src/spec/graph/types.ts"
import type { OpenApiDocument } from "../../src/spec/types.ts"
import { Redactor } from "../../src/security/redact.ts"

/* A static token sends without a request of its own, so no port is ever called. */
const unused = async (): Promise<never> => {
	throw new Error("a static recipe calls no port")
}
const PORTS: CredentialPorts = { operations: { call: unused }, steps: { run: unused }, tokens: { post: unused } }

/* A client that sends alpha's reference token wherever the document asks for a credential. */
function alphaClient(url: string, model: SpecModel): Client {
	const security: SecurityConfig = { bearer: { static: "tok_alpha" } }
	const principals: PrincipalsConfig = { alpha: { scope: { project_id: "proj_alpha" } } }
	const store = createStore({ ports: PORTS, principals, schemes: model.schemes, security })
	return new Client({
		baseUrl: url,
		credentials: createCredentialSource({ model, principals, security, store }),
		operationResolver: operationResolver(model),
		redactor: new Redactor(),
	})
}

describe("an ancestor two lanes need at once", () => {
	it("is created once and shared", async () => {
		const server = await createMemoryServer()
		try {
			const spec = (await (await fetch(`${server.url}/v1/openapi/spec`)).json()) as OpenApiDocument
			const model = buildModel(dereference(spec).doc)
			const rowCreate = model.byOperationId.get(model.entities.get("row")?.create ?? "")
			expect(rowCreate?.pathParams).toContain("table_id")
			const client = alphaClient(server.url, model)
			const ancestors = { creating: new Map<string, Promise<string>>(), made: new Map<string, string>() }
			const created: string[] = []
			const options = {
				ancestors,
				onCreate: (entity: string, id: string) => created.push(`${entity} ${id}`),
				principal: "alpha",
				roots: { project_id: "proj_alpha" },
				seed: 1,
			}
			const [first, second] = await Promise.all([
				resolvePathScope(rowCreate!, { client, model, options }),
				resolvePathScope(rowCreate!, { client, model, options }),
			])
			expect(created.filter((entry) => entry.startsWith("table "))).toHaveLength(1)
			expect(first.values.table_id).toBe(second.values.table_id)
		} finally {
			await server.close()
		}
	})
})
