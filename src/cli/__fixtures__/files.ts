import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { notesDoc } from "../../runtime/run/__fixtures__/api.ts"

/* Files a command reads, written to a fresh folder per test: a document, a config, a saved report. */

/** A fresh folder of its own. */
export function folder(): string {
	return mkdtempSync(join(tmpdir(), "oat-cli-"))
}

/** `body` written as JSON to `name` in `dir`; returns the path. */
export function json(dir: string, name: string, body: unknown): string {
	const path = join(dir, name)
	writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body))
	return path
}

/** The notes document on disk. */
export function notesSpec(dir: string = folder(), doc: unknown = notesDoc()): string {
	return json(dir, "openapi.json", doc)
}

/** A config on disk for the notes document beside it. */
export function notesConfig(dir: string = folder(), extra: Record<string, unknown> = {}): string {
	const spec = notesSpec(dir)
	return json(dir, "oat.config.json", {
		baseUrl: "http://api.test",
		principals: { alpha: { tenant: "t1" } },
		/* The notes document declares a bearer scheme; a fixed token satisfies it. */
		security: { bearer: { static: "t" } },
		spec,
		...extra,
	})
}

/*
 * The notes document with a sign-up: `account.create` makes the account a login's first step sends,
 * and `session.start` is the sign-in call after it, which belongs to no entity.
 */
const signupPaths = {
	"/accounts": {
		post: {
			operationId: "account.create",
			responses: { "201": { description: "made" } },
			security: [],
			"x-entity": { action: "create", identity: "id", name: "account" },
		},
	},
	"/session": { post: { operationId: "session.start", responses: { "200": { description: "ok" } }, security: [] } },
}

/** A config whose login signs up through `account.create`, then signs in at `session.start`, for that document. */
export function signupConfig(dir: string = folder()): string {
	return json(dir, "oat.config.json", {
		baseUrl: "http://api.test",
		principals: { alpha: { tenant: "t1" } },
		security: {
			bearer: {
				login: { from: "$.token", steps: [{ operationId: "account.create" }, { operationId: "session.start" }] },
			},
		},
		spec: notesSpec(dir, notesDoc(signupPaths)),
	})
}

/** A run folder `name` in `dir`, its saved report holding `report`. */
export function savedRun(dir: string, name: string, report: unknown): string {
	const run = join(dir, name)
	mkdirSync(run, { recursive: true })
	json(run, "oat-report.json", report)
	return run
}
