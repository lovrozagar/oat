#!/usr/bin/env node
import { buildModel } from "./spec/graph.ts"
import { dereference, loadSpec } from "./spec/load.ts"
import { report } from "./report/console.ts"

interface Args {
	command: string
	flags: Record<string, string | true>
}

function parseArgs(argv: string[]): Args {
	const [command = "help", ...rest] = argv
	const flags: Record<string, string | true> = {}
	for (let i = 0; i < rest.length; i++) {
		const token = rest[i]
		if (token === undefined || !token.startsWith("--")) continue
		const key = token.slice(2)
		const next = rest[i + 1]
		if (next !== undefined && !next.startsWith("--")) {
			flags[key] = next
			i++
		} else {
			flags[key] = true
		}
	}
	return { command, flags }
}

const USAGE = `oat — OpenAPI Tester

  oat plan    --spec <url|file>            derive and print the test model (offline)
  oat doctor  --spec <url|file>            report what oat can and cannot test, and why
  oat run     --spec <url|file> --base-url <url>   execute against a live backend
  oat conformance                          self-test: injected defects vs detection

Flags
  --spec       OpenAPI document, http(s) URL or filesystem path
  --base-url   backend under test
  --json       machine-readable output
`

async function main(): Promise<number> {
	const { command, flags } = parseArgs(process.argv.slice(2))

	if (command === "help" || flags.help === true) {
		process.stdout.write(USAGE)
		return 0
	}

	if (command === "conformance") {
		const { renderSuite, runSuite } = await import("./conformance/suite.ts")
		const only = typeof flags.only === "string" ? flags.only.split(",") : undefined
		const results = await runSuite(only)
		const { text, failures } = renderSuite(results)
		process.stdout.write(text)
		return failures > 0 ? 1 : 0
	}

	const spec = flags.spec
	if (typeof spec !== "string") {
		process.stderr.write("oat: --spec is required\n\n" + USAGE)
		return 2
	}

	const raw = await loadSpec(spec)
	const { doc, externalRefs } = dereference(raw)
	const model = buildModel(doc)

	switch (command) {
		case "plan":
			process.stdout.write(report.plan(model, flags.json === true))
			return 0
		case "doctor": {
			const output = report.doctor(model, externalRefs, flags.json === true)
			process.stdout.write(output.text)
			return output.blocking > 0 ? 1 : 0
		}
		case "run":
			process.stderr.write(
				"oat: `run` is not implemented yet — the execution layer is next.\n" +
					"Use `oat plan` and `oat doctor` against your spec in the meantime.\n",
			)
			return 2
		default:
			process.stderr.write(`oat: unknown command "${command}"\n\n${USAGE}`)
			return 2
	}
}

main().then(
	(code) => {
		process.exitCode = code
	},
	(error: unknown) => {
		process.stderr.write(`oat: ${error instanceof Error ? error.message : String(error)}\n`)
		process.exitCode = 1
	},
)
