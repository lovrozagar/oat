/**
 * Which co-occurring defect stops a check from firing — and whether that is correct.
 *
 *   node --experimental-sqlite tools/bisect.mjs TENANT_LEAK_VIA_FILTER
 *
 * Pairs the named defect with every other defect in turn and reports the ones whose presence
 * means the expected check never fires:
 *
 *   FILTER_AFTER_PAGINATION   -> SILENT       a bug: the check gave up without saying so
 *   STALE_LIST                -> suppressed   correct: a dependency failed first
 *
 * `SILENT` is what to fix — usually a missing `dependsOn`. A clean run prints only `done`.
 */
const dist = (name) => new URL(`../dist/${name}`, import.meta.url).href
const { createMemoryServer } = await import(dist("reference/http.js"))
const { run } = await import(dist("runtime/run.js"))
const { PRINCIPALS, EXPECTED } = await import(dist("conformance/suite.js"))
const { DEFECTS } = await import(dist("reference/defects.js"))

const target = process.argv[2]
if (target === undefined || DEFECTS[target] === undefined) {
	console.error(`usage: bisect.mjs <DEFECT>\nknown: ${Object.keys(DEFECTS).join(", ")}`)
	process.exit(1)
}
const expected = EXPECTED[target]
const want = Array.isArray(expected) ? expected[0] : expected

for (const other of Object.keys(DEFECTS)) {
	if (other === target) continue
	const server = await createMemoryServer({ defects: [target, other] })
	try {
		const result = await run({
			baseUrl: server.url,
			principals: PRINCIPALS,
			seed: 42,
			spec: `${server.url}/v1/openapi/spec`,
		})
		const fired = new Set(
			result.findings.filter((f) => f.verdict !== "COVERAGE_GAP").map((f) => f.check),
		)
		if (fired.has(want)) continue
		const suppressed = (result.checksSuppressed ?? []).some((x) => x.check === want)
		console.log(`${other.padEnd(30)} -> ${suppressed ? "suppressed" : "SILENT"}`)
	} finally {
		await server.close()
	}
}
console.log("done")
