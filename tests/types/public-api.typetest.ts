import { expectTypeOf } from "vitest"
import type * as oat from "../../src/index.ts"
import type {
	Actor,
	AuthStep,
	EntityConfig,
	EntityModel,
	ExternalStep,
	FieldType,
	FilterableField,
	FilterableFrom,
	FilterOp,
	Finding,
	HeaderRequest,
	Hooks,
	InputRequest,
	OatConfig,
	OpenApiDocument,
	OperationModel,
	OperationStep,
	OriginSpec,
	OutOfBandConfig,
	OutOfBandRequest,
	OutOfBandStep,
	PathValueRequest,
	PayloadPolicy,
	PrincipalEntry,
	PrincipalsConfig,
	ProfileSpec,
	QueryCapabilities,
	QueryCapabilitiesRequest,
	RateLimitSpec,
	Recipe,
	ReportInput,
	RequestStep,
	RunOptions,
	RunResult,
	Scenario,
	ScenarioAssert,
	ScenarioRequestStep,
	ScenarioStep,
	SecurityConfig,
	SideEffectRequest,
	SpecModel,
	TeardownPrincipalContext,
	UploadFile,
	UploadRequest,
	UploadResolution,
	Uploads,
	Verdict,
} from "../../src/index.ts"

/*
 * The public surface, pinned. A value export added or removed changes the key union below and fails
 * the type check; a type export removed fails its import. A new type export must also be documented
 * in docs/api.md, which tests/structure/docs-sync.test.ts enforces.
 */
expectTypeOf<keyof typeof oat>().toEqualTypeOf<
	| "allocateRunDir"
	| "buildModel"
	| "DEFAULT_RUNS_ROOT"
	| "defineConfig"
	| "dereference"
	| "env"
	| "EXIT"
	| "exitCode"
	| "loadConfig"
	| "loadPersistedPrincipals"
	| "loadSpec"
	| "renderJson"
	| "renderMarkdown"
	| "renderMatrixGraph"
	| "renderMatrixHtml"
	| "renderRepros"
	| "run"
	| "runVerdict"
	| "ScopeError"
	| "worstCaseWaitMs"
>()

/* `RunOptions.transcript`: how much of the transcript stays in memory, and where the encrypted rest is spooled. */
expectTypeOf<NonNullable<RunOptions["transcript"]>>().toEqualTypeOf<{ memoryBytes?: number; dir?: string }>()
expectTypeOf<{ transcript: { memoryBytes: number; dir: string } }>().toMatchTypeOf<Pick<RunOptions, "transcript">>()

export type PublicTypes = [
	Actor,
	AuthStep,
	EntityConfig,
	EntityModel,
	ExternalStep,
	FieldType,
	FilterableField,
	FilterableFrom,
	FilterOp,
	Finding,
	HeaderRequest,
	Hooks,
	InputRequest,
	OatConfig,
	OpenApiDocument,
	OperationModel,
	OperationStep,
	OriginSpec,
	OutOfBandConfig,
	OutOfBandRequest,
	OutOfBandStep,
	PathValueRequest,
	PayloadPolicy,
	PrincipalEntry,
	PrincipalsConfig,
	ProfileSpec,
	QueryCapabilities,
	QueryCapabilitiesRequest,
	RateLimitSpec,
	Recipe,
	ReportInput,
	RequestStep,
	RunOptions,
	RunResult,
	Scenario,
	ScenarioAssert,
	ScenarioRequestStep,
	ScenarioStep,
	SecurityConfig,
	SideEffectRequest,
	SpecModel,
	TeardownPrincipalContext,
	UploadFile,
	UploadRequest,
	UploadResolution,
	Uploads,
	Verdict,
]
