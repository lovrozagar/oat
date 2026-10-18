import { SHAPES } from "./catalog.ts"
import type { NamedShape } from "./types.ts"

/** The shape called `name`. Throws on a name no shape has, listing the ones there are. */
export function shapeNamed(name: string): NamedShape {
	const found = SHAPES.find((candidate) => candidate.name === name)
	if (found === undefined) {
		throw new Error(`unknown shape "${name}" — expected one of ${SHAPES.map((s) => s.name).join(", ")}`)
	}
	return found
}
