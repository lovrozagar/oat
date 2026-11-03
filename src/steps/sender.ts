import type { ScenarioRequestStep } from "../config/types/steps.ts"
import { RequestBuilder } from "./request.ts"
import type { CallInit, ErrorStatus, OpId, OpMap, OriginName, OriginOps, Refusal, RawInit, StepTypes } from "./types.ts"

/** Who a step goes out as, and where: the keys a sender adds to every step it builds. */
export interface Identity {
	anonymous?: true
	headers?: Record<string, string>
	principal?: string
	origin?: string
}

/** The scenario's own principal. */
export const SELF: Identity = {}
/** No credential at all. */
export const ANON: Identity = { anonymous: true }

/** A session held in the scope, sent with `headers` (which name it as `{name}`) in place of the principal's credential. */
export function sessionIdentity(headers: Record<string, string>): Identity {
	return { anonymous: true, headers }
}

/** Another config principal. */
export function principalIdentity(name: string): Identity {
	return { principal: name }
}

/* The parts of an init that are present: an optional part given as undefined is no part at all. */
function present<V extends object>(init: V): Partial<V> {
	return Object.fromEntries(Object.entries(init).filter(([, value]) => value !== undefined)) as Partial<V>
}

/**
 * Builds the request steps one identity sends. Typed over the operations `M` it may call and the
 * caller's `T`, so an unknown operation, body field, path parameter or error key fails to compile.
 */
export class Sender<M extends OpMap, T extends StepTypes> {
	readonly #identity: Identity

	constructor(identity: Identity) {
		this.#identity = identity
	}

	/** Calls an operation the document names. */
	call<K extends OpId<M>>(operationId: K, init: CallInit<M[K]> = {}): RequestBuilder<OpId<T["ops"]>> {
		return new RequestBuilder(this.#step({ operationId }, init))
	}

	/** Calls an operation and expects it refused with `status` and the declared error `key`. */
	refused<K extends OpId<M>, Status extends ErrorStatus<M[K]>>(
		operationId: K,
		refusal: Refusal<M[K], Status>,
	): RequestBuilder<OpId<T["ops"]>> {
		const { key, status, ...init } = refusal
		return new RequestBuilder<OpId<T["ops"]>>(this.#step({ operationId }, init))
			.status(status)
			.equals("$.error_key", key)
	}

	/** Sends a raw request, for a path the document does not describe. */
	request(method: string, path: string, init: RawInit = {}): RequestBuilder<OpId<T["ops"]>> {
		return new RequestBuilder(this.#step({ method, path }, init))
	}

	/** This sender, with every step it builds sent to the configured origin `name`. */
	on<O extends OriginName<T>>(name: O): Sender<OriginOps<T, O>, T> {
		return new Sender({ ...this.#identity, origin: name })
	}

	#step(target: { operationId: string } | { method: string; path: string }, init: object): ScenarioRequestStep {
		const { headers, ...rest } = present(init as { headers?: Record<string, string> })
		const own = this.#identity.headers
		const merged = headers === undefined && own === undefined ? {} : { headers: { ...own, ...headers } }
		return { ...this.#identity, ...rest, ...merged, ...target } as ScenarioRequestStep
	}
}
