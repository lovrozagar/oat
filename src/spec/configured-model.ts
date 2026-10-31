/**
 * The model a run plans against: the document read with config's parameter names, then config's
 * grammars laid over it. Config is the operator's own statement, so a name it cannot use stops the
 * run instead of testing something they did not ask for.
 */

import type { QueryParamNames } from "../config/types/query.ts"
import { UsageError } from "../errors/usage-error.ts"
import { isQueryParamRole, QUERY_PARAM_ROLES } from "./conventions/query-params.ts"
import { applyGrammarOverrides, type GrammarConfig } from "./grammar-overrides.ts"
import { buildModel } from "./graph/build.ts"
import type { SpecModel } from "./graph/types.ts"
import type { OpenApiDocument } from "./types.ts"

export type ModelConfig = GrammarConfig & { query?: { params?: QueryParamNames } }

export function buildConfiguredModel(doc: OpenApiDocument, config: ModelConfig): SpecModel {
	const params = readConfigParams(config.query?.params)
	const model = buildModel(doc, { queryParams: params })
	for (const [role, name] of Object.entries(params ?? {})) {
		if (!model.operations.some((op) => op.queryParamNames.includes(name))) {
			throw new UsageError(`query.params.${role} names "${name}", which no operation declares`)
		}
	}
	applyGrammarOverrides(model, config)
	return model
}

/* A config file is untyped until read: every key a role, every value a parameter name. */
function readConfigParams(raw: unknown): QueryParamNames | undefined {
	if (raw === undefined) return undefined
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new UsageError("query.params must be an object of role names")
	}
	for (const [role, name] of Object.entries(raw)) {
		if (!isQueryParamRole(role)) {
			throw new UsageError(
				`query.params names an unknown role "${role}"; the roles are ${QUERY_PARAM_ROLES.join(", ")}`,
			)
		}
		if (typeof name !== "string" || name === "") throw new UsageError(`query.params.${role} must be a parameter name`)
	}
	return raw as QueryParamNames
}
