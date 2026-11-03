import type { Scenario } from "../config/types/steps.ts"
import { external, type ExternalDraft } from "./external.ts"
import { mail, type MailDraft } from "./out-of-band.ts"
import { scenario, type ScenarioInit, unchecked } from "./scenario.ts"
import { ANON, principalIdentity, SELF, Sender, sessionIdentity } from "./sender.ts"
import type { Fillable, OpId, OriginName, OriginOps, StepTypes, Unchecked } from "./types.ts"

type Externals<T extends StepTypes> = NonNullable<T["externals"]>

/** An external's input argument: none for an external that takes none. */
type ExternalArgs<T extends StepTypes, N extends keyof Externals<T>> = Externals<T>[N] extends undefined
	? []
	: [input: Fillable<Externals<T>[N]>]

type MailKind<T extends StepTypes> = T extends { mail: infer K extends string } ? K : string

const NO_SESSION = "session(name) needs steps({ session }), the headers a session held in the scope is sent with"

/** How the builders send what the caller's API leaves to it. */
export interface StepsOptions {
	/** The configured origin a scenario of this set belongs to; give the set that origin's operations. */
	origin?: string
	/**
	 * The headers a session held in the scope as `{name}` is sent with, in place of the principal's
	 * credential: where a credential goes is the API's to say, never oat's.
	 */
	session?: (name: string) => Record<string, string>
}

/** The builders a scenario is written with, typed over the caller's `T`. */
export interface Builders<T extends StepTypes> {
	/** The scenario's own principal. */
	self: Sender<T["ops"], T>
	/** No credential at all. */
	anon: Sender<T["ops"], T>
	/** The session held in the scope as `{name}`, sent with the `session` option's headers. */
	session(name: string): Sender<T["ops"], T>
	/** Another config principal: an invitee accepting, a peer reading. */
	principal(name: string): Sender<T["ops"], T>
	/** The scenario's principal, calling a configured origin's operation as a support step. */
	origin<O extends OriginName<T>>(name: O): Sender<OriginOps<T, O>, T>
	/** A wait for a mailed token, a magic link, an OTP. */
	mail(kind: MailKind<T>, address: string): MailDraft
	/** A step only a person or a browser can do, answered by `hooks.external`. */
	external<N extends keyof Externals<T> & string>(name: N, ...input: ExternalArgs<T, N>): ExternalDraft
	/** The plain oat scenario; `covers` names this document's operations. */
	scenario(init: ScenarioInit<OpId<T["ops"]>>): Scenario
	/** A deliberately invalid value, sent as written. */
	unchecked<V>(value: V): V & Unchecked
}

/**
 * The step builders for one document. `origin` makes it the set for a scenario that belongs to that
 * configured origin: give it that origin's operations as `T["ops"]`, and its `scenario` names the
 * origin while its steps carry none. `session` says how `session(name)` sends a scope-held session.
 */
export function steps<T extends StepTypes>(options: StepsOptions = {}): Builders<T> {
	const self = new Sender<T["ops"], T>(SELF)
	const { origin, session } = options
	return {
		anon: new Sender(ANON),
		external: (name, ...input) => external(name, input[0] as Record<string, unknown> | undefined),
		mail,
		origin: (name) => self.on(name),
		principal: (name) => new Sender(principalIdentity(name)),
		scenario: (init) => scenario(origin === undefined ? init : { ...init, origin }),
		self,
		session: (name) => {
			if (session === undefined) throw new Error(NO_SESSION)
			return new Sender(sessionIdentity(session(name)))
		},
		unchecked,
	}
}
