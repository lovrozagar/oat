/** What an operation anyone may call answers with: security `[]`, and a 201. */
export const OPEN = { responses: { "201": { description: "made" } }, security: [] }

/** A JSON request body of `properties`. */
export function body(properties: Record<string, unknown>): Record<string, unknown> {
	return { requestBody: { content: { "application/json": { schema: { properties, type: "object" } } } } }
}
