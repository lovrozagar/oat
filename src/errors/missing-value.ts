/**
 * A request oat was about to make from a value it does not have.
 *
 * A record without its identity once became the text "undefined" in a path, a filter or a probe,
 * and the backend's answer to that was read as if it meant something. Nothing is sent: the check
 * that wanted the value is unresolved, with this as the reason.
 */
export class MissingValueError extends Error {
	override name = "MissingValueError"
	constructor(readonly where: string) {
		super(`oat had no value for ${where}`)
	}
}
