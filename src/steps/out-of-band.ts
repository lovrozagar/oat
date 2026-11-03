import type { OutOfBandStep } from "../config/types/steps.ts"
import type { BuiltStep } from "./types.ts"

/** A wait for a value that never travels over HTTP, bound to the scope as `as`. */
export class MailStep implements BuiltStep {
	readonly #step: OutOfBandStep

	constructor(step: OutOfBandStep) {
		this.#step = step
	}

	/** The value was sent before this scenario began, so no step here triggered it. */
	sentEarlier(): MailStep {
		return new MailStep({ outOfBand: { ...this.#step.outOfBand, sentEarlier: true } })
	}

	toStep(): OutOfBandStep {
		return this.#step
	}
}

/** An out-of-band wait that still needs the scope name its value binds to. */
export interface MailDraft {
	as(name: string): MailStep
}

/** Waits for the `kind` of value sent to `address`: a mailed token, a magic link, an OTP. */
export function mail(kind: string, address: string): MailDraft {
	return { as: (name) => new MailStep({ outOfBand: { address, as: name, kind } }) }
}
