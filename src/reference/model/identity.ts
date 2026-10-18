import type { EntityDef } from "./types.ts"

/**
 * The entity with its identity field called `renamed`. A renamed identity is renamed everywhere:
 * the document, the query grammar and the store — so the field, the per-field operator catalog
 * and the unique sets all follow it.
 */
export function renameIdentity(original: EntityDef, renamed: string): EntityDef {
	return {
		...original,
		fields: original.fields.map((field) => (field.name === original.identity ? { ...field, name: renamed } : field)),
		identity: renamed,
		...(original.filterCatalog?.opsByField === undefined
			? {}
			: {
					filterCatalog: {
						...original.filterCatalog,
						opsByField: Object.fromEntries(
							Object.entries(original.filterCatalog.opsByField).map(([field, ops]) => [
								field === original.identity ? renamed : field,
								ops,
							]),
						),
					},
				}),
		...(original.unique === undefined
			? {}
			: { unique: original.unique.map((set) => set.map((name) => (name === original.identity ? renamed : name))) }),
	}
}
