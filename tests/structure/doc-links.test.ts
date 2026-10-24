import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { describe, expect, it } from "vitest"

/*
 * Every relative link in the README and the docs lands somewhere: its file exists and, when it
 * names an anchor, the file has that heading (by GitHub's slug). A doc moved or split without its
 * links following fails here, with each broken link named.
 */

const ROOT = join(import.meta.dirname, "..", "..")

function markdownFiles(): string[] {
	const docs = readdirSync(join(ROOT, "docs"), { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.map((entry) => join(entry.parentPath, entry.name))
	return [join(ROOT, "README.md"), ...docs]
}

/** GitHub's heading anchor: lower case, punctuation but `-` and `_` dropped, each space a `-`. */
export function slug(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-")
}

function anchorsOf(file: string): Set<string> {
	const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "")
	return new Set([...text.matchAll(/^#{1,6} (.+)$/gm)].map((match) => slug(match[1] ?? "")))
}

/** Each relative link in a file whose target, or target heading, does not exist, as `file: link`. */
function broken(file: string): string[] {
	const text = readFileSync(file, "utf8").replace(/```[\s\S]*?```/g, "")
	const problems: string[] = []
	for (const match of text.matchAll(/\]\(([^)\s]+)\)/g)) {
		const link = match[1] ?? ""
		if (/^[a-z]+:/i.test(link)) continue
		const [path = "", anchor] = link.split("#")
		const target = path === "" ? file : join(dirname(file), path)
		const ok = existsSync(target) && (anchor === undefined || !target.endsWith(".md") || anchorsOf(target).has(anchor))
		if (!ok) problems.push(`${relative(ROOT, file)}: ${link}`)
	}
	return problems
}

describe("doc links", () => {
	it("slugs a heading the way GitHub does", () => {
		expect(slug("Security recipes")).toBe("security-recipes")
		expect(slug("`x-privileged`")).toBe("x-privileged")
		expect(slug("Removed in 0.25.0")).toBe("removed-in-0250")
	})

	it("resolve, every one, to a file and a heading that exist", () => {
		expect(markdownFiles().flatMap(broken)).toEqual([])
	})
})

describe("the configuration docs", () => {
	it("are split into principals and security, hooks, origins and uploads, and the reference", () => {
		const pages = readdirSync(join(ROOT, "docs", "configuration")).toSorted()
		expect(pages).toEqual(["hooks.md", "origins-and-uploads.md", "principals-and-security.md", "reference.md"])
		expect(existsSync(join(ROOT, "docs", "configuration.md"))).toBe(false)
	})

	it("come with a migration guide naming 0.25's breaking change to relative paths", () => {
		const guide = readFileSync(join(ROOT, "docs", "migrating-0.25.md"), "utf8")
		expect(guide).toMatch(/relative `spec`/)
		expect(guide).toMatch(/`outDir`/)
		expect(guide).toMatch(/config's (own )?folder/)
	})
})
