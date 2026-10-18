import { describe, expect, it } from "vitest"
import { rule } from "./no-module-side-effects.ts"
import { oxlintReports, reportsOf } from "./rule-harness.ts"

const MESSAGE = "module scope runs no code: mark a pure call /* @__PURE__ */ or move it into a function"

describe("oat/no-module-side-effects", () => {
	it("flags code that runs at import", () => {
		const fixture = {
			"src/runtime/a.ts": [
				"validateRegistry(CHECKS)",
				"export const x = compute()",
				"const y = new Thing()",
				"count += 1",
				"export default register()",
				"const z = await load()",
				"for (const a of b) use(a)",
				"const t = tag`x`",
				"export const nested = { value: [read()] }",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
		expect(reportsOf(rule, fixture)[0]?.message).toBe(MESSAGE)
	})

	it("allows declarations, deferred code and pure-marked calls", () => {
		const fixture = {
			"src/runtime/a.ts": [
				'"use strict"',
				'import { a } from "./a.ts"',
				'export { b } from "./b.ts"',
				'export * as c from "./c.ts"',
				"export function f() { run() }",
				"export class K { m() { run() } }",
				"export const g = () => run()",
				"export const h = function () { run() }",
				"export const K2 = class { static s = 1 }",
				"export const LIMIT = 3",
				"export const set = /* @__PURE__ */ new Set([1])",
				"export interface I { a: number }",
				"export type T = number",
				"export enum E { A }",
				"declare function d(): void",
				";",
				"export default function main() { run() }",
				"export default class {}",
				"export {}",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("leaves tests and code outside src alone", () => {
		const fixture = { "src/runtime/a.test.ts": "run()\n", "scripts/a.ts": "run()\n", "tests/support/a.ts": "run()\n" }
		expect(reportsOf(rule, fixture)).toEqual([])
	})

	it("lets a process entry point run its one call, and nothing else that is named like one", () => {
		expect(reportsOf(rule, { "src/cli.ts": "await start()\n", "src/conformance/worker.ts": "serve()\n" })).toEqual([])
		expect(reportsOf(rule, { "src/cli/cli.ts": "await start()\n" })).toHaveLength(1)
	})

	it("fails oxlint through the oat plugin entry", () => {
		expect(oxlintReports("no-module-side-effects", { "src/runtime/a.ts": "run()\n" }).length).toBe(1)
	})
})

describe("oat/no-module-side-effects definers", () => {
	it("treats a check definition as pure, and still checks what it is given", () => {
		const fixture = {
			"src/runtime/checks/families/a.ts": [
				'export const a = defineCheck({ id: "a", run: () => run() })',
				"export const b = defineCheck({ id: compute() })",
				"export const c = other.defineCheck({})",
			].join("\n"),
		}
		expect(reportsOf(rule, fixture).map(({ line }) => line)).toEqual([2, 3])
	})
})
