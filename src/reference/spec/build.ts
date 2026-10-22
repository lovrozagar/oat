/**
 * Generates the reference backend's OpenAPI document from the entity model, fully annotated with
 * the meta tags in the README. This is the "ideal citizen" spec: everything oat wants to know
 * is declared, so a run against the clean baseline exercises the tag path rather than the
 * heuristic fallbacks. The conformance suite also serves stripped variants to test the fallbacks.
 */

import type { Dialect } from "../dialect/types.ts"
import { POSTGREST } from "../dialect/presets.ts"
import { ENTITIES } from "../model/entities.ts"
import type { EntityDef } from "../model/types.ts"
import { authPaths } from "./auth.ts"
import { callerProfilePaths, callerRootPaths } from "./caller.ts"
import { collectionPathItem } from "./collection.ts"
import { components } from "./components.ts"
import { invitePaths } from "./invites.ts"
import { itemPathItem } from "./item.ts"
import { jobPaths } from "./jobs.ts"
import { hoistPathParameters } from "./layout.ts"
import { noticePaths, publicReadPaths } from "./public.ts"
import { searchPaths } from "./query-route.ts"
import { ROOT_SECURITY, securedByEntity } from "./security.ts"
import { stylePaths } from "./styles.ts"
import type { Json, SpecContext } from "./types.ts"

export type { SpecContext } from "./types.ts"

const DEFAULT_CONTEXT: SpecContext = { entities: ENTITIES, shape: {} }

function entityNamed(ctx: SpecContext, name: string): EntityDef {
	return ctx.entities.find((entity) => entity.name === name) as EntityDef
}

function buildPaths(ctx: SpecContext, dialect: Dialect): Json {
	const paths: Json = {}
	for (const entity of ctx.entities) {
		Object.assign(paths, {
			[entity.collectionPath]: securedByEntity(entity, collectionPathItem(ctx, entity, dialect)),
			[entity.itemPath]: securedByEntity(entity, itemPathItem(ctx, entity)),
		})
	}
	Object.assign(paths, callerProfilePaths(ctx), publicReadPaths(ctx), noticePaths(ctx), callerRootPaths(ctx))
	Object.assign(paths, invitePaths(ctx, entityNamed(ctx, "table")), jobPaths(ctx, entityNamed(ctx, "job")))
	return Object.assign(paths, authPaths(ctx), stylePaths(ctx), searchPaths(ctx))
}

export function buildSpec(dialect: Dialect = POSTGREST, ctx: SpecContext = DEFAULT_CONTEXT): Json {
	const paths = buildPaths(ctx, dialect)
	const rest = { security: ROOT_SECURITY }
	/* 3.2: the search route is a QUERY operation, a Path Item field since OAS 3.2. */
	const head = { info: { title: "oat reference backend", version: "1.0.0" }, openapi: "3.2.0" }
	/* Key order is the layout: a document is free to define its components before its paths, and
	 * to declare path parameters once on the path item rather than on every operation. */
	if (ctx.shape.specLayout === true) {
		return { ...head, components: components(ctx), paths: hoistPathParameters(paths), ...rest }
	}
	return { ...head, paths, components: components(ctx), ...rest }
}

function strip(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(strip)
	if (node === null || typeof node !== "object") return node
	const out: Json = {}
	for (const [key, value] of Object.entries(node as Json)) {
		if (key.startsWith("x-") && key !== "x-root") continue
		out[key] = strip(value)
	}
	return out
}

/** Variant with every oat meta tag removed — exercises the heuristic fallbacks. */
export function buildUntaggedSpec(dialect: Dialect = POSTGREST, ctx: SpecContext = DEFAULT_CONTEXT): Json {
	return strip(buildSpec(dialect, ctx)) as Json
}
