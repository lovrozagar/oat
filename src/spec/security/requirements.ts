import type { OpenApiDocument, OperationObject } from "../types.ts"

/*
 * Which credentials an operation needs, by OAS 3.1/3.2 rules. An operation's `security` replaces
 * the document's. The array is a choice (any one alternative will do); each object is a set
 * (every scheme in it at once). An empty array, or an empty object among the alternatives, means
 * the operation can be called anonymously.
 */

/** One scheme an alternative needs, with the scopes it must carry. */
export interface Requirement {
	scheme: string
	scopes: string[]
}

export interface ResolvedSecurity {
	/** Any one of these satisfies the operation; `[]` is the anonymous alternative. */
	alternatives: Requirement[][]
	/** Where the requirement came from: the operation, the document root, or nowhere. */
	source: "operation" | "root" | "none"
	/** Schemes a requirement names that the document never declares. */
	undeclared: string[]
}

type Declared = ReadonlyArray<Record<string, readonly string[]>>

function alternativesOf(declared: Declared): Requirement[][] {
	if (declared.length === 0) return [[]]
	return declared.map((set) => Object.entries(set).map(([scheme, scopes]) => ({ scheme, scopes: [...scopes] })))
}

/** The requirement an operation carries, resolved against its document. */
export function resolveSecurity(op: OperationObject, doc: OpenApiDocument): ResolvedSecurity {
	const declared = op.security ?? doc.security
	const source = op.security !== undefined ? "operation" : doc.security !== undefined ? "root" : "none"
	const alternatives = alternativesOf(declared ?? [])
	const schemes = doc.components?.securitySchemes ?? {}
	const named = new Set(alternatives.flat().map((requirement) => requirement.scheme))
	const undeclared = [...named].filter((scheme) => !Object.hasOwn(schemes, scheme)).toSorted()
	return { alternatives, source, undeclared }
}
