import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { OpenApiDocument, OperationObject } from "../types.ts"
import { resolveSecurity } from "./requirements.ts"

/*
 * Requirement resolution over arbitrary documents: the operation's `security` replaces the root's,
 * the array is a choice of sets, and an empty array or empty set is the anonymous alternative.
 */

type Declared = Array<Record<string, string[]>>

/* Scheme names, `Object.prototype`'s own among them, so a declared check must be an own-key one. */
const schemeName = fc.oneof(fc.stringMatching(/^[A-Za-z][\w-]{0,6}$/), fc.constantFrom("constructor", "toString"))
const scopes = fc.array(fc.stringMatching(/^[a-z:]{1,6}$/), { maxLength: 3 })
const requirementSet = fc.dictionary(schemeName, scopes, { maxKeys: 3, noNullPrototype: true })
const declared: fc.Arbitrary<Declared> = fc.array(requirementSet, { maxLength: 4 })
const maybeDeclared = fc.option(declared, { nil: undefined })

const documentOf = (root: Declared | undefined, schemes: string[]): OpenApiDocument => ({
	components: { securitySchemes: Object.fromEntries(schemes.map((name) => [name, { type: "http" }])) },
	...(root === undefined ? {} : { security: root }),
})
const operationOf = (security: Declared | undefined): OperationObject => (security === undefined ? {} : { security })

/* The alternatives a declared array reads as, written independently: each set's entries in order. */
const expected = (sets: Declared) =>
	sets.length === 0 ? [[]] : sets.map((set) => Object.keys(set).map((scheme) => ({ scheme, scopes: set[scheme] })))

describe("resolveSecurity, by property", () => {
	it("lets a declared operation requirement win over any root", () => {
		fc.assert(
			fc.property(declared, maybeDeclared, fc.array(schemeName), (op, root, schemes) => {
				const resolved = resolveSecurity(operationOf(op), documentOf(root, schemes))
				expect(resolved.source).toBe("operation")
				expect(resolved.alternatives).toEqual(expected(op))
			}),
		)
	})

	it("falls back to the root, and to anonymous when neither declares one", () => {
		fc.assert(
			fc.property(maybeDeclared, fc.array(schemeName), (root, schemes) => {
				const resolved = resolveSecurity(operationOf(undefined), documentOf(root, schemes))
				expect(resolved.source).toBe(root === undefined ? "none" : "root")
				expect(resolved.alternatives).toEqual(expected(root ?? []))
			}),
		)
	})

	it("keeps an empty set as an anonymous alternative in its declared place", () => {
		fc.assert(
			fc.property(declared, fc.nat(4), (sets, at) => {
				const withAnonymous = sets.toSpliced(Math.min(at, sets.length), 0, {})
				const { alternatives } = resolveSecurity(operationOf(withAnonymous), documentOf(undefined, []))
				expect(alternatives[Math.min(at, sets.length)]).toEqual([])
				expect(alternatives).toHaveLength(withAnonymous.length)
			}),
		)
	})

	it("names as undeclared exactly the required schemes the document lacks, sorted and once each", () => {
		fc.assert(
			fc.property(declared, fc.array(schemeName), (op, schemes) => {
				const { undeclared } = resolveSecurity(operationOf(op), documentOf(undefined, schemes))
				const named = new Set(op.flatMap((set) => Object.keys(set)))
				const lacking = [...named].filter((name) => !schemes.includes(name))
				expect(undeclared).toEqual(lacking.toSorted())
			}),
		)
	})

	it("is deterministic and leaves the document's scope arrays its own", () => {
		fc.assert(
			fc.property(declared, maybeDeclared, (op, root) => {
				const doc = documentOf(root, [])
				const before = structuredClone(op)
				const first = resolveSecurity(operationOf(op), doc)
				expect(resolveSecurity(operationOf(op), doc)).toEqual(first)
				for (const requirement of first.alternatives.flat()) requirement.scopes.push("mutated")
				expect(op).toEqual(before)
			}),
		)
	})
})
