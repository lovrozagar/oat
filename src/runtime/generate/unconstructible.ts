/** Why no value can be made for a schema, and where in it: the one failure generation reports. */
export class Unconstructible extends Error {
	constructor(
		readonly reason: string,
		readonly pointer: string,
	) {
		super(reason)
	}
}
