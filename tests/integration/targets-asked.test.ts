import { describe, expect, it } from "vitest"
import { targetsAsked } from "../targets/target.ts"

/* `OAT_TARGETS` picks which real APIs the target run starts; a dispatch that names none runs all. */

describe("targetsAsked", () => {
	it("takes no list, or an empty one, as every target", () => {
		expect(targetsAsked(undefined)).toBeUndefined()
		expect(targetsAsked("")).toBeUndefined()
		expect(targetsAsked(" , ")).toBeUndefined()
	})

	it("names the targets a list asks for, trimmed", () => {
		expect(targetsAsked("keycloak, vampi,")).toEqual(["keycloak", "vampi"])
	})
})
