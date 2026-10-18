import type { OpenApiDocument } from "../../../../../spec/types.ts"
import { type NotesOptions, notesDocument } from "./notes.ts"

/*
 * Notes nested under parents below the tenant: `/orgs/{org_id}/books/{book_id}/notes`. Each parent
 * is its own entity, with whichever of list, read and create the test asks for.
 */

export interface Parent {
	/** Collection segment, such as `books`. */
	segment: string
	/** Path parameter of one parent, such as `book_id`. */
	param: string
	list?: boolean
	read?: boolean
	create?: boolean
	/** The read at a path of its own, tagged to the parent entity. */
	readPath?: string
}

const ROW = { properties: { id: { type: "string" }, name: { type: "string" } }, type: "object" }

function json(schema: unknown): Record<string, unknown> {
	return { content: { "application/json": { schema } } }
}

function paramsOf(path: string): Array<Record<string, unknown>> {
	return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
		in: "path",
		name: match[1],
		required: true,
		schema: { type: "string" },
	}))
}

function parentPaths(parent: Parent, collection: string, item: string): Record<string, Record<string, unknown>> {
	const entity = { "x-entity": { name: parent.segment.replace(/s$/, "") } }
	const name = parent.segment.replace(/s$/, "")
	const paths: Record<string, Record<string, unknown>> = { [collection]: {}, [item]: {} }
	if (parent.list === true) {
		paths[collection] = {
			...paths[collection],
			get: {
				operationId: `list_${name}`,
				parameters: paramsOf(collection),
				responses: { "200": { description: "rows", ...json({ items: ROW, type: "array" }) } },
			},
		}
	}
	if (parent.create === true) {
		paths[collection] = {
			...paths[collection],
			post: {
				operationId: `create_${name}`,
				parameters: paramsOf(collection),
				requestBody: json(ROW),
				responses: { "201": { description: "made", ...json(ROW) } },
			},
		}
	}
	if (parent.read === true) {
		const at = parent.readPath ?? item
		paths[at] = {
			...paths[at],
			get: {
				operationId: `read_${name}`,
				parameters: paramsOf(at),
				responses: { "200": { description: "one", ...json(ROW) } },
				...entity,
			},
		}
	}
	return Object.fromEntries(Object.entries(paths).filter(([, operations]) => Object.keys(operations).length > 0))
}

/** Notes under `parents`, each beneath the one before, below `prefix`. */
export function nestedDocument(
	parents: readonly Parent[],
	options: NotesOptions & { prefix?: string } = {},
): OpenApiDocument {
	let root = options.prefix ?? "/orgs/{org_id}"
	let extraPaths: Record<string, Record<string, unknown>> = {}
	for (const parent of parents) {
		const collection = `${root}/${parent.segment}`
		const item = `${collection}/{${parent.param}}`
		extraPaths = { ...extraPaths, ...parentPaths(parent, collection, item) }
		root = item
	}
	return notesDocument({ ...options, extraPaths: { ...extraPaths, ...options.extraPaths }, root })
}
