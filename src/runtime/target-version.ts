/**
 * Which build of the backend a run tested.
 *
 * Read once, after sign-in and before anything is created, from a version route: a JSON path into
 * its body or a response header. It goes through the client like every request, so the fence and
 * the allowlist apply. A version that cannot be read is noted in the report; it never changes the
 * verdict, because it says nothing about the backend's behaviour.
 */

import type { SpecModel } from "../spec/graph.ts"
import type { Client } from "../client/client.ts"
import { readPath } from "./path.ts"
import { fillPath } from "./fill-path.ts"

import type { TargetVersionSpec } from "../config/types/config.ts"

export type { TargetVersionSpec } from "../config/types/config.ts"

export type TargetVersion = { value: string } | { error: string }

/**
 * What the version read is stamped with. Its failure is the version's `error`, not a server error
 * of the run: a documented version route is still called, and graded, by the contract floor.
 */
export const TARGET_VERSION_READ = "run.target-version"

export async function readTargetVersion(
	spec: TargetVersionSpec,
	model: SpecModel,
	client: Pick<Client, "get">,
	headers: () => Record<string, string>,
	roots: Record<string, string>,
): Promise<TargetVersion> {
	let path: string
	if (spec.operationId !== undefined) {
		const op = model.byOperationId.get(spec.operationId)
		if (op === undefined) return { error: `targetVersion.operationId "${spec.operationId}" names no operation` }
		try {
			path = fillPath(op.path, roots)
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) }
		}
	} else if (spec.path !== undefined) {
		path = spec.path
	} else {
		return { error: "targetVersion needs an operationId or a path" }
	}
	let exchange: Awaited<ReturnType<Client["get"]>>
	try {
		exchange = await client.get(path, {
			headers: headers(),
			...(spec.operationId === undefined ? {} : { operationId: spec.operationId }),
		})
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) }
	}
	if (exchange.status < 200 || exchange.status >= 300) return { error: `GET ${path} returned ${exchange.status}` }
	const header = /^header:(.+)$/i.exec(spec.from)?.[1]?.trim().toLowerCase()
	const value =
		header === undefined
			? readPath(exchange.responseBody, spec.from)
			: Object.entries(exchange.responseHeaders).find(([name]) => name.toLowerCase() === header)?.[1]
	if (typeof value === "string" || typeof value === "number") return { value: String(value) }
	return { error: `${spec.from} is not in the response of GET ${path}` }
}
