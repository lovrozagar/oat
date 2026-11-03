/*
 * What a caller tells the step builders about its API, so a scenario that names an operation, a
 * body field, a path parameter or an error key the API lacks fails to compile. Nothing here exists
 * at run time: the builders emit oat's plain step objects.
 */

import type { ScenarioStep } from "../config/types/steps.ts"

/** One operation as a caller's types describe it. Every part is optional: a part left out takes nothing. */
export interface OpShape {
	/** The JSON request body. */
	body?: unknown
	/** The path parameters, filled through `bind`. */
	bind?: object
	/** The query parameters. */
	query?: object
	/** The error keys the operation declares, per status: `{ 403: "forbidden" | "email_not_verified" }`. */
	errors?: { readonly [status: number]: string }
}

/** Operation id → its shape. */
export type OpMap = { readonly [operationId: string]: OpShape }

/** Everything the builders are typed over. Only `ops` is required. */
export interface StepTypes {
	/** The operations of the document the scenario runs against. */
	ops: OpMap
	/** Configured `origins[]` name → that origin's operations, for a support step sent there. */
	origins?: { readonly [origin: string]: OpMap }
	/** External step name → the input it takes (`undefined` for none). */
	externals?: { readonly [name: string]: object | undefined }
	/** The out-of-band kinds `hooks.resolveOutOfBand` answers. */
	mail?: string
}

/** A text holding a `{name}` placeholder, filled from the flow's scope when the step runs. */
export type Placeholder = `${string}{${string}}${string}`

type Bytes = ArrayBuffer | ArrayBufferView | Blob

/** `T` with every scalar leaf also accepting a placeholder text; bytes are content and pass as they are. */
export type Fillable<T> = T extends Bytes
	? T
	: T extends readonly (infer U)[]
		? Fillable<U>[]
		: T extends object
			? { [K in keyof T]: Fillable<T[K]> }
			: T | Placeholder

/** A value written `unchecked(...)`: sent as it is, outside the operation's body type. */
export interface Unchecked {
	readonly "~unchecked": true
}

/** A builder `scenario()` turns into the plain step it stands for. */
export interface BuiltStep {
	toStep(): ScenarioStep
}

/** What a scenario's steps may hold: builders, and plain steps such as a sign-up flow's. */
export type StepItem = BuiltStep | ScenarioStep

/** An operation id of `M`. */
export type OpId<M extends OpMap> = keyof M & string

/** A configured origin's name. */
export type OriginName<T extends StepTypes> = keyof NonNullable<T["origins"]> & string

/** The operations of origin `O`. */
export type OriginOps<T extends StepTypes, O extends OriginName<T>> = NonNullable<T["origins"]>[O] & OpMap

/** The parameter names part `K` of `S` declares, each filled with a text; none when `S` has no such part. */
type Params<S extends OpShape, K extends "bind" | "query"> = K extends keyof S
	? { [P in keyof NonNullable<S[K]>]?: string }
	: { [P in never]?: string }

/** The body `S` takes; with no body declared, only an `unchecked(...)` one. */
type BodyOf<S extends OpShape> = "body" extends keyof S ? Fillable<NonNullable<S["body"]>> | Unchecked : Unchecked

/** What an operation call sends besides the operation id. */
export interface CallInit<S extends OpShape = OpShape> {
	body?: BodyOf<S>
	bind?: Params<S, "bind">
	query?: Params<S, "query">
	/** Merged over a session's headers, these winning per key. */
	headers?: Record<string, string>
	/** One of the request media types the operation documents. */
	mediaType?: string
}

/** A status `S` declares error keys for. */
export type ErrorStatus<S extends OpShape> = "errors" extends keyof S ? keyof NonNullable<S["errors"]> & number : never

/** A refused call: the status and the declared error key the response must carry, plus the call's init. */
export type Refusal<S extends OpShape, Status extends number> = CallInit<S> & {
	status: Status
	key: Status extends keyof NonNullable<S["errors"]> ? NonNullable<S["errors"]>[Status] : never
}

/** What a raw request sends besides its method and path. */
export interface RawInit {
	body?: unknown
	headers?: Record<string, string>
	query?: Record<string, string>
	redirect?: "follow" | "manual"
}
