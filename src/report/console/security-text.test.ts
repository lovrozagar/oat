import { describe, expect, it } from "vitest"
import { anyrow, everyScheme } from "../../spec/security/__fixtures__/documents.ts"
import { documentOf } from "./__fixtures__/models.ts"
import { ANYROW, credentials, legacy, model } from "./__fixtures__/security.ts"
import { securityFacts } from "./security.ts"
import { planSecurityLines, securityLines, targetSecurity } from "./security-text.ts"

/* What doctor and plan print about credentials: aligned columns of schemes, requirement groups and operations. */

describe("securityLines: schemes", () => {
	it("lists each scheme's placement and recipe", () => {
		const lines = securityLines(securityFacts(model(anyrow), ANYROW))
		expect(lines.slice(0, 3)).toEqual([
			"  security — 2 schemes",
			"    apiKey     apiKey          header Authorization: ApiKey {credential}   static · format",
			"    jwt        bearer (JWT)    header Authorization: Bearer {credential}   login",
		])
		const every = securityLines(securityFacts(model(everyScheme)))
		expect(every[0]).toBe("  security — 11 schemes")
		expect(every).toContain(
			"    basic      basic                     header Authorization: Basic base64(username:password)   —",
		)
		expect(every).toContain(
			"    bearer     bearer (JWT) (deprecated) header Authorization: Bearer {credential}               —",
		)
		expect(every).toContain(
			"    query      apiKey                    query api_key: {credential}                             —",
		)
		expect(every).toContain(
			"    mtls       unsupported               mutualTLS is a TLS client certificate, not a request credential",
		)
	})

	it("shows a recipe's extra placements, and a recipe only a principal names", () => {
		const lines = securityLines(
			securityFacts(
				model(anyrow),
				credentials(
					{ apiKey: { placements: [{ in: "query", name: "key" }], static: "k" } },
					{ alpha: {}, beta: { security: { jwt: { static: "t" } } } },
				),
			),
		)
		expect(lines[1]).toMatch(/ {3}static · \+1 placement$/)
		expect(lines[2]).toMatch(/ {3}static$/)
		const two = securityFacts(
			model(anyrow),
			credentials({
				apiKey: {
					placements: [
						{ in: "query", name: "a" },
						{ in: "query", name: "b" },
					],
					static: "k",
				},
			}),
		)
		expect(securityLines(two)[1]).toMatch(/ {3}static · \+2 placements$/)
		expect(securityLines(two)[2]).toMatch(/ {3}no recipe$/)
		const basic = securityLines(
			securityFacts(
				model(everyScheme),
				credentials({ basic: { format: "Basic {credential}", static: { password: "p", username: "u" } } }),
			),
		)
		expect(basic[1]).toMatch(/header Authorization: Basic \{credential\} +static · format$/)
	})
})

describe("securityLines: requirements", () => {
	it("groups operations by requirement with the satisfying principal", () => {
		const lines = securityLines(securityFacts(model(anyrow), ANYROW))
		expect(lines.slice(3, 11)).toEqual([
			"",
			"  writer — alpha (first principal)",
			"",
			"  requirements — 3 operations",
			"    anonymous                       1",
			"    jwt                             1   alpha",
			"    jwt | apiKey[rows:read]         1   alpha via jwt",
			"",
		])
		expect(lines).toHaveLength(11)
	})

	it("omits the principal column without a config", () => {
		const lines = securityLines(securityFacts(model(anyrow)))
		expect(lines.slice(4)).toEqual([
			"  requirements — 3 operations",
			"    anonymous                       1",
			"    jwt                             1",
			"    jwt | apiKey[rows:read]         1",
			"    pass --config to see which principal satisfies each operation",
			"",
		])
		expect(lines[1]).toMatch(/ {3}—$/)
	})
})

describe("securityLines: what a run cannot send", () => {
	it("lists schemes with no recipe, and the operations no principal can send", () => {
		const facts = securityFacts(model(legacy), credentials({ jwt: { static: "t" } }))
		expect(securityLines(facts).slice(7)).toEqual([
			"    legacy                          2   none — no credential for legacy",
			"    jwt                             1   alpha",
			"",
			"  no recipe — operations needing only these are untested",
			"    legacy     2 operations; add security.legacy",
			"",
		])
		expect(facts.blocking).toBe(2)
		expect(securityFacts(model(legacy)).blocking).toBe(0)
	})

	it("lists unsupported schemes with the operations that need only them, and undeclared ones", () => {
		const lines = securityLines(securityFacts(model(everyScheme)))
		const from = lines.indexOf("  unsupported — operations needing only these are untested")
		expect(lines.slice(from)).toEqual([
			"  unsupported — operations needing only these are untested",
			"    broken     0 operations",
			"    digest     0 operations",
			"    mtls       1 operation",
			"    strange    0 operations",
			"  undeclared — a requirement names it, components.securitySchemes does not",
			"    missing    1 operation",
			"",
		])
		expect(lines).not.toContain("  no recipe — operations needing only these are untested")
	})

	it("says a document with no scheme declares none", () => {
		const bare = documentOf({ "/a": { get: { operationId: "a.get", responses: { "200": { description: "ok" } } } } })
		expect(securityLines(securityFacts(model(bare))).slice(0, 4)).toEqual([
			"  security — 0 schemes",
			"",
			"  requirements — 1 operation",
			"    anonymous                       1",
		])
	})
})

describe("planSecurityLines and targetSecurity", () => {
	it("lists every operation, by id, with its requirement and principal", () => {
		expect(planSecurityLines(securityFacts(model(anyrow), ANYROW))).toEqual([
			"",
			"  security — operation · requirement · principal",
			"    auth.login               anonymous",
			"    me.get                   jwt                       alpha",
			"    row.list                 jwt | apiKey[rows:read]   alpha via jwt",
		])
		expect(planSecurityLines(securityFacts(model(anyrow))).slice(2)).toEqual([
			"    auth.login               anonymous",
			"    me.get                   jwt",
			"    row.list                 jwt | apiKey[rows:read]",
			"    pass --config to see which principal satisfies each operation",
		])
	})

	it("states one target's requirement, with its principal when there is a config", () => {
		const facts = securityFacts(model(anyrow), ANYROW)
		expect(targetSecurity(facts, "row.list")).toBe("  jwt | apiKey[rows:read] (alpha via jwt)")
		expect(targetSecurity(facts, "auth.login")).toBe("  anonymous")
		expect(targetSecurity(securityFacts(model(anyrow)), "me.get")).toBe("  jwt")
		expect(targetSecurity(facts, "no.such")).toBe("")
	})
})

describe("securityLines: the writer", () => {
	it("names the writer and why: the config's writer, or the first principal", () => {
		const two = { alpha: {}, beta: {} }
		const named = securityLines(securityFacts(model(anyrow), { ...credentials(ANYROW.security, two), writer: "beta" }))
		expect(named).toContain("  writer — beta (config writer)")
		const first = securityLines(securityFacts(model(anyrow), credentials(ANYROW.security, two)))
		expect(first).toContain("  writer — alpha (first principal)")
		expect(securityLines(securityFacts(model(anyrow))).join("\n")).not.toContain("writer —")
	})
})
