import { describe, expect, it } from "vitest"
import { Slots } from "./slots.ts"

describe("Slots", () => {
	it("admits up to its size, then each release lets the next waiter in, in order", async () => {
		const slots = new Slots(2)
		const order: string[] = []
		await slots.acquire()
		await slots.acquire()
		const third = slots.acquire().then(() => order.push("third"))
		const fourth = slots.acquire().then(() => order.push("fourth"))
		await Promise.resolve()
		expect(order).toEqual([])
		slots.release()
		await third
		expect(order).toEqual(["third"])
		slots.release()
		await fourth
		expect(order).toEqual(["third", "fourth"])
	})

	it("frees a slot on release when nobody waits", async () => {
		const slots = new Slots(1)
		await slots.acquire()
		slots.release()
		let admitted = false
		void slots.acquire().then(() => {
			admitted = true
		})
		await Promise.resolve()
		expect(admitted).toBe(true)
	})
})
