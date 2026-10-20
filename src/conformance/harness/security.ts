/**
 * The security every conformance mini-document declares: one http bearer scheme, required at the
 * root, so each suite's config gives it a recipe the way a real user would. A suite about another
 * placement declares its own.
 */

/** The `components.securitySchemes` and root `security` a document spreads in, fresh each call. */
export function bearerSecurity(): {
	components: { securitySchemes: { bearer: { scheme: string; type: string } } }
	security: Array<Record<string, string[]>>
} {
	return { components: { securitySchemes: { bearer: { scheme: "bearer", type: "http" } } }, security: [{ bearer: [] }] }
}
