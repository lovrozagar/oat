/**
 * The model a run plans against: the document read with config's parameter and envelope names, then
 * config's grammars laid over it. Config is the operator's own statement, so a name it cannot use stops the
 * run instead of testing something they did not ask for.
 */

import type { QueryEnvelopeNames, QueryParamNames } from "../config/types/query.ts"
import { UsageError } from "../errors/usage-error.ts"
import { isQueryEnvelopeRole, QUERY_ENVELOPE_ROLES } from "./conventions/envelope-names.ts"
import { isQueryParamRole, QUERY_PARAM_ROLES } from "./conventions/query-params.ts"
import { applyGrammarOverrides, type GrammarConfig } from "./grammar-overrides.ts"
import { buildModel } from "./graph/build.ts"
import type { SpecModel } from "./graph/types.ts"
import type { OpenApiDocument } from "./types.ts"

export type ModelConfig = GrammarConfig & { query?: { params?: QueryParamNames; envelope?: QueryEnvelopeNames } }

export function buildConfiguredModel(doc: OpenApiDocument, config: ModelConfig): SpecModel {
	const params = readNames<QueryParamNames>(config.query?.params, PARAMS)
	const envelope = readNames<QueryEnvelopeNames>(config.query?.envelope, ENVELOPE)
	const model = buildModel(doc, { queryEnvelope: envelope, queryParams: params })
	applyGrammarOverrides(model, config)
	return model
}

/**
 * Stops on a config name no model of the run declares. Config is run-wide, read against the primary
 * document and each origin's, so a name only an origin declares is not a typo.
 */
export function assertQueryNamesDeclared(config: ModelConfig, models: readonly SpecModel[]): void {
	const operations = models.flatMap((model) => model.operations)
	for (const [role, name] of Object.entries(config.query?.params ?? {})) {
		if (!operations.some((op) => op.queryParamNames.includes(name))) {
			throw new UsageError(`query.params.${role} names "${name}", which no operation declares`)
		}
	}
	for (const [role, name] of Object.entries(config.query?.envelope ?? {})) {
		if (!operations.some((op) => op.collection?.envelopeKeys.includes(name) === true)) {
			throw new UsageError(`query.envelope.${role} names "${name}", which no list response declares`)
		}
	}
}

/* What a names object is read as: its config key, its roles, and what each value names. */
interface Names {
	key: "params" | "envelope"
	isRole: (role: string) => boolean
	roles: readonly string[]
	names: string
}

const PARAMS: Names = { isRole: isQueryParamRole, key: "params", names: "a parameter name", roles: QUERY_PARAM_ROLES }
const ENVELOPE: Names = {
	isRole: isQueryEnvelopeRole,
	key: "envelope",
	names: "a field name",
	roles: QUERY_ENVELOPE_ROLES,
}

/* A config file is untyped until read: every key a role, every value a name. */
function readNames<T>(raw: unknown, { isRole, key, names, roles }: Names): T | undefined {
	if (raw === undefined) return undefined
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new UsageError(`query.${key} must be an object of role names`)
	}
	for (const [role, name] of Object.entries(raw)) {
		if (!isRole(role)) {
			throw new UsageError(`query.${key} names an unknown role "${role}"; the roles are ${roles.join(", ")}`)
		}
		if (typeof name !== "string" || name === "") throw new UsageError(`query.${key}.${role} must be ${names}`)
	}
	return raw as T
}
