import type { ParserResult } from "../harness/result.ts"

export function renderParserSuite(results: ParserResult[]): { text: string; failures: number } {
	const lines: string[] = []
	let failures = 0
	lines.push("")
	lines.push("  spec fixture                  result")
	lines.push("  ─────────────────────────────────────────────────────────────────────────")
	for (const result of results) {
		if (!result.ok) failures++
		lines.push(`  ${result.ok ? "✓" : "✗"} ${result.name.padEnd(28)} ${result.detail}`)
		if (!result.ok) lines.push(`      ${result.why}`)
	}
	lines.push("")
	lines.push(`  ${results.length - failures}/${results.length} hostile specs handled`)
	lines.push("")
	return { failures, text: lines.join("\n") }
}
