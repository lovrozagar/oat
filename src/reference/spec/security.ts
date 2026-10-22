/** The document's security: a bearer JWT everywhere by default, or an entity-scoped API key on record routes. */

import { SAFE } from "../../spec/methods.ts"
import type { EntityDef } from "../model/types.ts"
import type { Json } from "./types.ts"

/** The schemes: a bearer JWT, and an API key sent in Authorization as `ApiKey <key>`. */
export const SECURITY_SCHEMES: Json = {
	apiKey: { description: "ApiKey <key>", in: "header", name: "Authorization", type: "apiKey" },
	jwt: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
}

/** What every operation needs unless it says otherwise: the JWT. */
export const ROOT_SECURITY: Json[] = [{ jwt: [] }]

/** A record route's path item, each operation taking a JWT or an API key with the entity's read or write scope. */
export function securedByEntity(entity: EntityDef, item: Json): Json {
	const out: Json = {}
	for (const [method, operation] of Object.entries(item)) {
		const access = SAFE.has(method.toUpperCase()) ? "read" : "write"
		out[method] = { ...(operation as Json), security: [{ jwt: [] }, { apiKey: [`${entity.name}:${access}`] }] }
	}
	return out
}
