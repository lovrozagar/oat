import type { NetworkInterfaceInfo } from "node:os"
import { describe, expect, it } from "vitest"
import { hasUsableInterface, refineNetworkKind } from "./interfaces.ts"

const info = (address: string, internal: boolean): NetworkInterfaceInfo =>
	({ address, internal }) as unknown as NetworkInterfaceInfo

const online = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
	eth0: [info("10.0.0.2", false)],
	lo: [info("127.0.0.1", true)],
})
const loopbackOnly = (): NodeJS.Dict<NetworkInterfaceInfo[]> => ({
	blank: [info("", false)],
	gone: undefined,
	lo: [info("127.0.0.1", true)],
})

const unread = (): NodeJS.Dict<NetworkInterfaceInfo[]> => {
	throw new Error("read")
}

describe("hasUsableInterface", () => {
	it("needs one external interface with an address", () => {
		expect(hasUsableInterface(online)).toBe(true)
		expect(hasUsableInterface(loopbackOnly)).toBe(false)
		expect(hasUsableInterface(() => ({}))).toBe(false)
	})

	it("reads this machine's interfaces by default", () => {
		expect(typeof hasUsableInterface()).toBe("boolean")
	})
})

describe("refineNetworkKind", () => {
	it("keeps the kind while a link exists, and reads any failure without one as offline", () => {
		expect(refineNetworkKind("dns", online)).toBe("dns")
		expect(refineNetworkKind("dns", loopbackOnly)).toBe("offline")
	})

	it("never looks at the interfaces for a failure already offline", () => {
		expect(refineNetworkKind("offline", unread)).toBe("offline")
	})

	it("reads this machine's interfaces by default", () => {
		expect(["reset", "offline"]).toContain(refineNetworkKind("reset"))
	})
})
