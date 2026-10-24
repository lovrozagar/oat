/**
 * Which build of the backend a run tested.
 *
 * Read once, after sign-in and before anything is created, from a version route: a JSON path into
 * its body or a response header. It goes through the client like every request, so the fence and
 * the allowlist apply. A version that cannot be read is noted in the report; it never changes the
 * verdict, because it says nothing about the backend's behavior.
 */

import type { SpecModel } from "../spec/graph/types.ts"
import type { Client } from "../client/client.ts"
import type { RequestOptions } from "../client/types.ts"
import { readPath } from "../client/read-path.ts"
import { fillPath } from "./fill-path.ts"
import { headerValue } from "./headers.ts"
import type { Exchange } from "./exchange.ts"
import { messageOf } from "../errors/message.ts"

import type { TargetVersionSpec } from "../config/types/config.ts"

export type { TargetVersionSpec } from "../config/types/config.ts"

export type TargetVersion = { value: string } | { error: string }

/**
 * What the version read is stamped with. Its failure is the version's `error`, not a server error
 * of the run: a documented version route is still called, and graded, by the contract floor.
 */
export const TARGET_VERSION_READ = "run.target-version"

/** What reading the version needs: where it is, and how to ask as the first principal. */
export interface TargetVersionRead {
	spec: TargetVersionSpec
	model: SpecModel
	client: Pick<Client, "get">
	/** The first principal: an operation's security chooses its scheme; a path sends the configured `scheme`. */
	principal: string
	/** Path ids for a version operation's parameters. */
	roots: Record<string, string>
}

export async function readTargetVersion(read: TargetVersionRead): Promise<TargetVersion> {
	const { client, principal, spec } = read
	const target = versionPath(read)
	if ("error" in target) return target
	const { path } = target
	let exchange: Awaited<ReturnType<Client["get"]>>
	try {
		exchange = await client.get(path, versionRequest(spec, principal))
	} catch (error) {
		return { error: messageOf(error) }
	}
	if (exchange.status < 200 || exchange.status >= 300) return { error: `GET ${path} returned ${exchange.status}` }
	const value = versionIn(exchange, spec.from)
	if (typeof value === "string" || typeof value === "number") return { value: String(value) }
	return { error: `${spec.from} is not in the response of GET ${path}` }
}

/*
 * Who reads the version. A documented operation's security picks the first principal's scheme. An
 * undocumented path has no security to resolve, so it names its scheme or is read anonymously.
 */
function versionRequest(spec: TargetVersionSpec, principal: string): RequestOptions {
	if (spec.operationId !== undefined) return { as: { principal }, operationId: spec.operationId }
	return { as: spec.scheme === undefined ? { anonymous: true } : { principal, scheme: spec.scheme } }
}

/** The path the version is read from: the operation's, filled from the roots, or the configured one. */
function versionPath(read: TargetVersionRead): { path: string } | { error: string } {
	const { model, roots, spec } = read
	if (spec.operationId === undefined) {
		return spec.path === undefined ? { error: "targetVersion needs an operationId or a path" } : { path: spec.path }
	}
	const op = model.byOperationId.get(spec.operationId)
	if (op === undefined) return { error: `targetVersion.operationId "${spec.operationId}" names no operation` }
	try {
		return { path: fillPath(op.path, roots) }
	} catch (error) {
		return { error: messageOf(error) }
	}
}

/** The value `from` names: a response header (`header:<name>`), or a JSON path into the body. */
function versionIn(exchange: Exchange, from: string): unknown {
	const header = /^header:(.+)$/i.exec(from)?.[1]?.trim()
	return header === undefined ? readPath(exchange.responseBody, from) : headerValue(exchange.responseHeaders, header)
}
