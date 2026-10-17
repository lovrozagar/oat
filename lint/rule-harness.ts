import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseSync } from "oxc-parser"
import type { Comment, Node, Rule, Visitors } from "./ast.ts"

/** Repo-relative path → source. A rule decides by path, so a fixture mirrors the real layout. */
export type Fixture = Record<string, string>

/** One finding: the fixture path, the 1-based line it starts on, and the rule's message. */
export interface Report {
	file: string
	line: number
	message: string
}

const PLUGIN = join(import.meta.dirname, "index.ts")
const OXLINT = join(dirname(createRequire(import.meta.url).resolve("oxlint/package.json")), "bin", "oxlint")

const lineOf = (code: string, offset: number): number => code.slice(0, offset).split("\n").length

/* The comments that touch `node` with only whitespace between, as ESLint's SourceCode reports them. */
function commentsBefore(code: string, comments: Comment[], node: Node): Comment[] {
	const out: Comment[] = []
	let edge = node.start
	for (const comment of comments.toReversed()) {
		if (comment.end > edge) continue
		if (code.slice(comment.end, edge).trim() !== "") break
		out.unshift(comment)
		edge = comment.start
	}
	return out
}

function commentsAfter(code: string, comments: Comment[], node: Node): Comment[] {
	const out: Comment[] = []
	let edge = node.end
	for (const comment of comments) {
		if (comment.start < edge) continue
		if (code.slice(edge, comment.start).trim() !== "") break
		out.push(comment)
		edge = comment.end
	}
	return out
}

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && "type" in value

function childrenOf(node: Node): Node[] {
	return Object.entries(node)
		.filter(([key]) => key !== "parent")
		.flatMap(([, value]) => (Array.isArray(value) ? value : [value]))
		.filter(isNode)
}

/* Every node gets its parent before any visitor runs, as oxlint gives them. */
function link(node: Node, parent: Node | null): void {
	node.parent = parent
	for (const child of childrenOf(node)) link(child, node)
}

function visit(node: Node, visitors: Visitors): void {
	visitors[node.type]?.(node as never)
	for (const child of childrenOf(node)) visit(child, visitors)
}

/** Runs `rule` in process over every fixture file, the way oxlint hands it each file. */
export function reportsOf(rule: Rule, fixture: Fixture): Report[] {
	const reports: Report[] = []
	for (const [file, code] of Object.entries(fixture)) {
		const filename = `/repo/${file}`
		const parsed = parseSync(filename, code)
		const comments = parsed.comments as Comment[]
		const visitors = rule.create({
			filename,
			report: ({ message, node }) => reports.push({ file, line: lineOf(code, node.start), message }),
			sourceCode: {
				getAllComments: () => comments,
				getCommentsAfter: (node) => commentsAfter(code, comments, node),
				getCommentsBefore: (node) => commentsBefore(code, comments, node),
				getText: (node) => (node === undefined ? code : code.slice(node.start, node.end)),
			},
		})
		const program = parsed.program as unknown as Node
		link(program, null)
		visit(program, visitors)
	}
	return reports
}

function insideGitCheckout(dir: string): boolean {
	for (let at = dir; at !== dirname(at); at = dirname(at)) if (existsSync(join(at, ".git"))) return true
	return false
}

/** Runs the real oxlint binary with the oat plugin and only `oat/<name>` on, over the fixture. */
export function oxlintReports(name: string, fixture: Fixture): Report[] {
	const dir = mkdtempSync(join(tmpdir(), "oat-lint-"))
	try {
		/* oxlint applies a checkout's .gitignore even with --no-ignore, so a fixture inside one lints nothing. */
		if (insideGitCheckout(dir)) throw new Error(`TMPDIR ${tmpdir()} is inside a git checkout; set it outside one`)
		const config = {
			categories: { correctness: "off", suspicious: "off" },
			jsPlugins: [{ name: "oat", specifier: PLUGIN }],
			plugins: [],
			rules: { [`oat/${name}`]: "error" },
		}
		writeFileSync(join(dir, ".oxlintrc.json"), JSON.stringify(config))
		for (const [file, code] of Object.entries(fixture)) {
			mkdirSync(dirname(join(dir, file)), { recursive: true })
			writeFileSync(join(dir, file), code)
		}
		const files = Object.keys(fixture).map((file) => join(dir, file))
		const args = ["--config", join(dir, ".oxlintrc.json"), "--format", "json", "--no-ignore", ...files]
		const proc = spawnSync(OXLINT, args, { encoding: "utf8" })
		if (!proc.stdout.trimStart().startsWith("{")) {
			const why = `status ${proc.status}, signal ${proc.signal}, error ${proc.error?.message}`
			throw new Error(`oxlint printed no report (${why}): ${proc.stderr}`.trim())
		}
		const out = JSON.parse(proc.stdout) as {
			diagnostics: Array<{ filename: string; labels: Array<{ span: { line: number } }>; message: string }>
		}
		return out.diagnostics
			.map((d) => ({ file: d.filename.slice(dir.length + 1), line: d.labels[0]?.span.line ?? 0, message: d.message }))
			.toSorted((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))
	} finally {
		rmSync(dir, { force: true, recursive: true })
	}
}
