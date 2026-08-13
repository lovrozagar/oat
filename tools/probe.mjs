/**
 * Run one defect set and print what fired, what was suppressed, and what could not conclude.
 *
 *   node --experimental-sqlite tools/probe.mjs STALE_LIST+SELECT_IGNORED [dialect] [backend]
 */
const dist = (name) => new URL(`../dist/${name}`, import.meta.url).href
const http = await import(dist("reference/http.js"))
const { run } = await import(dist("runtime/run.js"))
const { PRINCIPALS } = await import(dist("conformance/suite.js"))

const [combo, dialect = "postgrest", backend = "sqlite"] = process.argv.slice(2)
const factory =
	backend === "memory"
		? http.createMemoryServer
		: backend === "postgres"
			? http.createPostgresServer
			: http.createSqliteServer

const server = await factory({ defects: combo === undefined ? [] : combo.split("+"), dialect })
try {
	const result = await run({
		baseUrl: server.url,
		principals: PRINCIPALS,
		seed: 42,
		spec: `${server.url}/v1/openapi/spec`,
	})
	const real = result.findings.filter((f) => f.verdict !== "COVERAGE_GAP")
	console.log(`### ${combo ?? "(clean)"} · ${backend} · ${dialect}`)
	console.log(`  fired: ${[...new Set(real.map((f) => f.check))].join(", ") || "nothing"}`)
	for (const finding of real) {
		console.log(`    [${finding.verdict}] ${finding.check} (${finding.entity})`)
		console.log(`      ${String(finding.detail).replace(/\s+/g, " ").slice(0, 200)}`)
	}
	const suppressed = [...new Set((result.checksSuppressed ?? []).map((x) => `${x.check} <- ${x.because}`))]
	if (suppressed.length > 0) console.log(`  suppressed: ${suppressed.join(", ")}`)
	const unresolved = [...new Set((result.inconclusive ?? []).map((x) => `${x.check}: ${x.reason}`))]
	if (unresolved.length > 0) console.log(`  inconclusive: ${unresolved.join(" | ")}`)
} finally {
	await server.close()
}
