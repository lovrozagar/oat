import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { credentialHeaderNames, stripCredentials } from "../../security/strip.ts"
import { Redactor } from "../../security/redact.ts"
import { placementOf } from "./placement.ts"
import { readSchemes, type SecurityScheme } from "./schemes.ts"

/*
 * Placement over every scheme kind: a scheme oat can send has one placement with one `{credential}`
 * slot, decided by its kind and location alone, and a declared name reaches the wire as written.
 */

const name = fc.stringMatching(/^[A-Za-z][\w-]{0,10}$/)
const location = fc.constantFrom("header" as const, "query" as const, "cookie" as const)
const base = fc.record({ deprecated: fc.boolean(), name })
const flow = fc.record({ scopes: fc.array(name, { maxLength: 2 }), tokenUrl: fc.webUrl() })

const supported: fc.Arbitrary<SecurityScheme> = fc.oneof(
	fc.tuple(base, fc.option(name, { nil: undefined })).map(([b, format]) => ({
		...b,
		kind: "bearer" as const,
		...(format === undefined ? {} : { bearerFormat: format }),
	})),
	base.map((b) => ({ ...b, kind: "basic" as const })),
	fc.tuple(base, location, name).map(([b, at, param]) => ({ ...b, in: at, kind: "apiKey" as const, param })),
	fc.tuple(base, flow).map(([b, f]) => ({ ...b, flows: { clientCredentials: f }, kind: "oauth2" as const })),
	fc.tuple(base, fc.webUrl()).map(([b, url]) => ({ ...b, kind: "openIdConnect" as const, openIdConnectUrl: url })),
)
const unsupported = fc
	.tuple(base, fc.string())
	.map(([b, why]): SecurityScheme => ({ ...b, kind: "unsupported", unsupported: why }))

/* Every casing of `text`, chosen letter by letter. */
const recased = (text: string) =>
	fc
		.array(fc.boolean(), { maxLength: text.length, minLength: text.length })
		.map((upper) => [...text].map((char, i) => (upper[i] ? char.toUpperCase() : char.toLowerCase())).join(""))

describe("placementOf, by property", () => {
	it("gives a sendable scheme one placement with exactly one credential slot", () => {
		fc.assert(
			fc.property(supported, (scheme) => {
				const placement = placementOf(scheme)
				expect(placement).not.toBeNull()
				expect(placement?.template.split("{credential}")).toHaveLength(2)
				expect(placement?.encode === "base64").toBe(scheme.kind === "basic")
			}),
		)
	})

	it("gives an unsupported scheme none", () => {
		fc.assert(
			fc.property(unsupported, (scheme) => {
				expect(placementOf(scheme)).toBeNull()
			}),
		)
	})

	it("depends on the kind and location alone, never the scheme's name, deprecation or flows", () => {
		fc.assert(
			fc.property(supported, base, (scheme, other) => {
				const renamed = { ...scheme, ...other }
				expect(placementOf(renamed)).toEqual(placementOf(scheme))
				expect(placementOf(scheme)).toEqual(placementOf(structuredClone(scheme)))
			}),
		)
	})
})

describe("placementOf on declared names, by property", () => {
	it("places a declared apiKey under its declared location and name, verbatim", () => {
		fc.assert(
			fc.property(name, location, name, (scheme, at, param) => {
				const read = readSchemes({
					components: { securitySchemes: { [scheme]: { in: at, name: param, type: "apiKey" } } },
				})
				expect(placementOf(read.get(scheme) as SecurityScheme)).toEqual({
					in: at,
					name: param,
					template: "{credential}",
				})
			}),
		)
	})

	it("names a header that stripping and redaction then match in any casing", () => {
		const header = supported
			.map((scheme) => placementOf(scheme))
			.filter((placement) => placement?.in === "header")
			.chain((placement) => fc.tuple(fc.constant(placement?.name ?? ""), recased(placement?.name ?? "")))
		fc.assert(
			fc.property(header, ([placed, sent]) => {
				const headers = { [sent]: "value", accept: "json" }
				stripCredentials(headers, credentialHeaderNames([placed]))
				expect(headers).toEqual({ accept: "json" })
				const redactor = new Redactor()
				redactor.registerHeader(placed)
				expect(redactor.isSecretHeader(sent)).toBe(true)
			}),
		)
	})
})
