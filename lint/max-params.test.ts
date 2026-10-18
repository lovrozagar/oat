import { describe, expect, it } from "vitest"
import { rule } from "./max-params.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const MESSAGE = "a function takes at most 3 parameters, plus a first `ctx`: pass the rest as one options object"

describe("oat/max-params", () => {
	it("flags a fourth parameter in every kind of function", () => {
		const fixture = {
			"src/runtime/a.ts": [
				"export function f(a, b, c, d) {}",
				"export const g = (a, b, c, d) => a",
				"export const h = function (a, b = 1, ...c) {}",
				"export class K { m(a, { b }, [c], d) {} }",
				"export const i = async (a, b, c, d = 1) => a",
				"export const j = (a, b, c, ...d) => a",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([1, 2, 4, 5, 6])
		expect(reportsOf(rule, fixture)[0]?.message).toBe(MESSAGE)
	})

	it("does not count a first `ctx`, nor a TypeScript `this`", () => {
		const fixture = {
			"src/runtime/a.ts": [
				"export function f(ctx: C, a: number, b: number, c: number) {}",
				"export function g(this: Window, a: number, b: number, c: number) {}",
				"export function h(this: Window, ctx: C, a: number, b: number, c: number) {}",
				"export class K { constructor(private readonly a: A, b: B, c: C) {} }",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("counts a `ctx` anywhere but first, and every parameter past a first one", () => {
		const fixture = {
			"src/runtime/a.ts": [
				"export const f = (a: number, b: number, c: number, ctx?: C) => a",
				"export function g(ctx: C, a: number, b: number, c: number, d: number) {}",
				"export function h(ctx: C, ctx2: C, a: number, b: number, c: number) {}",
				"export class K { constructor(private readonly a: A, b: B, c: C, d: D) {} }",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([1, 2, 3, 4])
	})

	it("holds overloads and abstract signatures to it", () => {
		const fixture = {
			"src/runtime/a.ts": [
				"export function f(a: A, b: B, c: C, d: D): void",
				"export function f(a: A): void",
				"export function f(...args: unknown[]): void {}",
				"export abstract class K { abstract m(a: A, b: B, c: C, d: D): void }",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([1, 4])
	})
})

describe("oat/max-params reach", () => {
	it("holds tests, scripts and labs to it too", () => {
		const fixture = {
			"src/runtime/a.test.ts": "const f = (a, b, c, d) => a\n",
			"scripts/x.ts": "function f(a, b, c, d) {}\n",
			"labs/kit/y.ts": "function f(a, b, c, d) {}\n",
		}
		expect(reportsOf(rule, fixture)).toHaveLength(3)
	})

	it("fails oxlint through the oat plugin entry", () => {
		const fixture = { "src/runtime/a.ts": "export function f(a, b, c, d) {}\nexport function g(ctx, a, b, c) {}\n" }
		expect(oxlintReports("max-params", fixture).map(({ line }) => line)).toEqual([1])
	})
})
