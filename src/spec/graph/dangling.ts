/**
 * Internal `$ref`s that point at nothing, operation by operation. `dereference` reads each as a
 * `DANGLING_KEY` node. In a schema that node is unconstrained, so validation of what it covers is
 * vacuous and the operation carries a gap saying so. Anywhere else (a parameter, a body, a response,
 * a header, an example, a link, a callback) the operation cannot be read safely: a missing required
 * path parameter would make every request wrong, so the operation is left untested.
 */

import type { GapCollector } from "../extensions/gaps.ts"
import { DEFS_ID } from "../load/defs.ts"
import { DANGLING_KEY } from "../load/walk.ts"
import { PATH_ITEM_METHODS } from "../methods.ts"
import type { Endpoint } from "../types.ts"
import type { OperationModel } from "./types.ts"
import { leaveUntested } from "./unmodelled.ts"

/* The dangling pointers one operation reaches, by where they sit. */
interface Found {
	defs: Readonly<Record<string, unknown>>
	/** Schema nodes already searched: shared subschemas are searched once per operation. */
	seen: Set<object>
	schema: Set<string>
	structure: Set<string>
}

type Visit = (found: Found, node: Record<string, unknown>) => void

const DEF_PREFIX = `${DEFS_ID}#/$defs/`

const isRecord = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)

/* A node of document structure: a dangling one is recorded, any other is read by `visit`. */
function at(found: Found, node: unknown, visit: Visit): void {
	if (!isRecord(node)) return
	const pointer = node[DANGLING_KEY]
	if (typeof pointer === "string") found.structure.add(pointer)
	else visit(found, node)
}

/* Every entry of a map or list of structure nodes. */
function each(found: Found, nodes: unknown, visit: Visit): void {
	if (nodes !== null && typeof nodes === "object") for (const node of Object.values(nodes)) at(found, node, visit)
}

const leaf: Visit = () => undefined

/* A schema and everything under it, recursive definitions included. */
function schema(found: Found, node: unknown): void {
	if (node === null || typeof node !== "object" || found.seen.has(node)) return
	found.seen.add(node)
	const record = node as Record<string, unknown>
	const pointer = record[DANGLING_KEY]
	if (typeof pointer === "string") found.schema.add(pointer)
	const ref = record["$ref"]
	if (typeof ref === "string" && ref.startsWith(DEF_PREFIX)) schema(found, found.defs[ref.slice(DEF_PREFIX.length)])
	for (const value of Object.values(node)) schema(found, value)
}

const media: Visit = (found, node) => {
	schema(found, node["schema"])
	schema(found, node["itemSchema"])
	each(found, node["examples"], leaf)
	each(found, node["encoding"], (inner, encoding) => each(inner, encoding["headers"], parameter))
}

/* A Parameter Object, or a Header Object, which has the same shape without a name. */
const parameter: Visit = (found, node) => {
	schema(found, node["schema"])
	each(found, node["content"], media)
	each(found, node["examples"], leaf)
}

const response: Visit = (found, node) => {
	each(found, node["headers"], parameter)
	each(found, node["content"], media)
	each(found, node["links"], leaf)
}

const pathItem: Visit = (found, node) => {
	each(found, node["parameters"], parameter)
	for (const method of PATH_ITEM_METHODS) at(found, node[method], operation)
}

const operation: Visit = (found, node) => {
	each(found, node["parameters"], parameter)
	at(found, node["requestBody"], (inner, body) => each(inner, body["content"], media))
	each(found, node["responses"], response)
	each(found, node["callbacks"], (inner, callback) => each(inner, callback, pathItem))
}

/**
 * Records a `$ref` gap for each dangling pointer each operation reaches, and leaves an operation
 * untested when one sits outside a schema. `operations` are `endpoints` modelled, in order.
 */
export function recordDangling(
	endpoints: readonly Endpoint[],
	operations: readonly OperationModel[],
	{ defs, gaps }: { defs: Readonly<Record<string, unknown>>; gaps: GapCollector },
): void {
	endpoints.forEach((endpoint, index) => {
		const found: Found = { defs, schema: new Set(), seen: new Set(), structure: new Set() }
		operation(found, endpoint.op as unknown as Record<string, unknown>)
		const op = operations[index] as OperationModel
		for (const pointer of found.schema) {
			gaps.record(op.operationId, "$ref", `$ref ${pointer} points at nothing; oat reads that schema as unconstrained`)
		}
		for (const pointer of found.structure) {
			gaps.record(op.operationId, "$ref", `$ref ${pointer} points at nothing; oat leaves this operation untested`)
		}
		const [first] = found.structure
		if (first !== undefined && op.unsendable === null) leaveUntested(op, `$ref ${first} points at nothing`)
	})
}
