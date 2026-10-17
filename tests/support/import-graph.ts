import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, normalize, relative } from "node:path"
import { parseSync } from "oxc-parser"

/** Module → the modules it imports, every form counted: values, types, re-exports and literal `import()`. */
export type ImportGraph = Map<string, Set<string>>

interface Sourced {
	type: string
	source?: { type: string; value?: unknown } | null
}

function sourcesOf(file: string, code: string): string[] {
	const found: string[] = []
	const visit = (node: unknown): void => {
		if (typeof node !== "object" || node === null) return
		const sourced = node as Sourced
		const literal = sourced.source?.type === "Literal" ? sourced.source.value : undefined
		if (typeof literal === "string" && literal.startsWith(".")) found.push(literal)
		for (const value of Object.values(node)) {
			for (const child of Array.isArray(value) ? value : [value]) visit(child)
		}
	}
	visit(parseSync(file, code).program)
	return found
}

/** The import graph of every non-test `.ts` module under `dir`, keyed by repo-relative path. */
export function importGraph(root: string, dir: string): ImportGraph {
	const modules = readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
		.map((entry) => relative(root, join(entry.parentPath, entry.name)))
		.filter((file) => !file.includes("/__fixtures__/"))
	const known = new Set(modules)
	const graph: ImportGraph = new Map()
	for (const file of modules) {
		const targets = sourcesOf(file, readFileSync(join(root, file), "utf8"))
			.map((spec) => normalize(join(dirname(file), spec)))
			.filter((target) => known.has(target))
		graph.set(file, new Set(targets))
	}
	return graph
}

/** Every strongly connected component of more than one module, or with a self-import (Tarjan). */
export function cycles(graph: ImportGraph): string[][] {
	let next = 0
	const index = new Map<string, number>()
	const low = new Map<string, number>()
	const stack: string[] = []
	const onStack = new Set<string>()
	const found: string[][] = []
	const connect = (node: string): void => {
		index.set(node, next)
		low.set(node, next)
		next += 1
		stack.push(node)
		onStack.add(node)
		for (const target of graph.get(node) ?? []) {
			if (!index.has(target)) {
				connect(target)
				low.set(node, Math.min(low.get(node) ?? 0, low.get(target) ?? 0))
			} else if (onStack.has(target)) {
				low.set(node, Math.min(low.get(node) ?? 0, index.get(target) ?? 0))
			}
		}
		if (low.get(node) !== index.get(node)) return
		const component: string[] = []
		let member: string | undefined
		do {
			member = stack.pop()
			if (member === undefined) break
			onStack.delete(member)
			component.push(member)
		} while (member !== node)
		if (component.length > 1 || graph.get(node)?.has(node) === true) found.push(component.toSorted())
	}
	for (const node of graph.keys()) if (!index.has(node)) connect(node)
	return found.toSorted((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""))
}
