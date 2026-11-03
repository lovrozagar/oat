import { describe, expect, it } from "vitest"
import { mail } from "./out-of-band.ts"

describe("mail", () => {
	it("waits for the kind at the address and binds what arrives", () => {
		expect(mail("magic-link", "{address}").as("mlToken").toStep()).toStrictEqual({
			outOfBand: { address: "{address}", as: "mlToken", kind: "magic-link" },
		})
	})

	it("marks a value sent before the scenario began", () => {
		expect(mail("offer", "a@anyrow.ai").as("offerLink").sentEarlier().toStep()).toStrictEqual({
			outOfBand: { address: "a@anyrow.ai", as: "offerLink", kind: "offer", sentEarlier: true },
		})
	})
})
