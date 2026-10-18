/** Which entity route a path names, and the path parameters it carries. */

import type { EntityDef } from "../model/types.ts"

export interface Match {
	entity: EntityDef
	scope: Record<string, string>
	itemId: string | null
}

export function matchRoute(pathname: string, entities: readonly EntityDef[]): Match | null {
	const segments = pathname.split("/").filter(Boolean)
	for (const entity of entities) {
		for (const [template, isItem] of [
			[entity.itemPath, true],
			[entity.collectionPath, false],
		] as const) {
			const scope = bind(template, segments)
			if (scope !== null) return { entity, itemId: isItem ? (scope[entity.itemParam] ?? null) : null, scope }
		}
	}
	return null
}

/* The parameters `template` takes from `segments`, or `null` when the path is not one of its. */
function bind(template: string, segments: readonly string[]): Record<string, string> | null {
	const parts = template.split("/").filter(Boolean)
	if (parts.length !== segments.length) return null
	const scope: Record<string, string> = {}
	for (const [index, part] of parts.entries()) {
		const value = segments[index] as string
		if (part.startsWith("{")) scope[part.slice(1, -1)] = decodeURIComponent(value)
		else if (part !== value) return null
	}
	return scope
}
