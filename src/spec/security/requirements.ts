import type { OpenApiDocument, OperationObject } from "../types.ts"

/*
 * Which credentials an operation needs, by OAS 3.1/3.2 rules. An operation's `security` replaces
 * the document's. The array is a choice (any one alternative will do); each object is a set
 * (every scheme in it at once). An empty array, or an empty object among the alternatives, means
 * the operation can be called anonymously. A scheme whose scopes are not a list (Square gives `null`)
 * is read as needing none, and named so the operation can carry a gap.
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
	/** Schemes a requirement gives scopes that are not a list: each was read as needing no scopes. */
	malformedScopes: string[]
}

/* As the document has it: a scope list may be anything. */
type Declared = ReadonlyArray<Record<string, unknown>>

function alternativesOf(declared: Declared): Requirement[][] {
	if (declared.length === 0) return [[]]
	return declared.map((set) =>
		Object.entries(set).map(([scheme, scopes]) => ({ scheme, scopes: Array.isArray(scopes) ? [...scopes] : [] })),
	)
}

/* The schemes `declared` gives scopes that are not a list, each once. */
function malformedScopesOf(declared: Declared): string[] {
	const named = declared.flatMap((set) => Object.entries(set).filter(([, scopes]) => !Array.isArray(scopes)))
	return [...new Set(named.map(([scheme]) => scheme))].toSorted()
}

/** The requirement an operation carries, resolved against its document. */
export function resolveSecurity(op: OperationObject, doc: OpenApiDocument): ResolvedSecurity {
	const declared: Declared | undefined = op.security ?? doc.security
	const source = op.security !== undefined ? "operation" : doc.security !== undefined ? "root" : "none"
	const alternatives = alternativesOf(declared ?? [])
	const schemes = doc.components?.securitySchemes ?? {}
	const named = new Set(alternatives.flat().map((requirement) => requirement.scheme))
	const undeclared = [...named].filter((scheme) => !Object.hasOwn(schemes, scheme)).toSorted()
	return { alternatives, malformedScopes: malformedScopesOf(declared ?? []), source, undeclared }
}
