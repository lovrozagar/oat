import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { leftBehind, unreportedLeftovers } from "../../src/conformance/leaks.ts"
import { PRINCIPALS, SECURITY } from "../../src/conformance/matrix/principals.ts"
import { createMemoryServer } from "../../src/reference/http/engines.ts"
import type { ReferenceServer } from "../../src/reference/http/server.ts"
import { exitCode } from "../../src/runtime/exit.ts"
import { run } from "../../src/runtime/run/index.ts"
import type { RunOptions } from "../../src/runtime/run/types.ts"

/*
 * Every account a run signs up is torn down, or named as a leftover. The reference makes one for
 * each disposable session, from a body generated for its register; it removes one by
 * `profile.delete` as the account itself, or by an admin's `account.delete`.
 */

let reference: ReferenceServer | undefined
let folder: string | undefined
afterEach(async () => {
	await reference?.close()
	reference = undefined
	if (folder !== undefined) await rm(folder, { force: true, recursive: true })
	folder = undefined
})

interface Ledgered {
	accounts: Array<{ operationId: string; identity: Record<string, string>; status: string; note?: string }>
}

async function runAgainst(more: Partial<RunOptions> = {}) {
	reference = await createMemoryServer()
	folder = await mkdtemp(join(tmpdir(), "oat-accounts-"))
	const accountsFile = join(folder, "accounts.json")
	const before = await reference.snapshot()
	const result = await run({
		accountsFile,
		baseUrl: reference.url,
		principals: PRINCIPALS,
		security: SECURITY,
		seed: 42,
		spec: `${reference.url}/v1/openapi/spec`,
		...more,
	})
	const leaked = leftBehind(before, await reference.snapshot()).filter((row) => row.startsWith("account "))
	const raw = await readFile(accountsFile, "utf8")
	return { leaked, ledger: JSON.parse(raw) as Ledgered, raw, result }
}

/* The accounts sign-ups made: a register refused, an invalid body's say, made none. */
const made = (ledger: Ledgered): Ledgered["accounts"] => ledger.accounts.filter((entry) => entry.status !== "refused")

/* The register body's email, as each sign-up that made an account sent it. */
const emails = (ledger: Ledgered): string[] => made(ledger).map((entry) => entry.identity["email"] as string)

describe("the accounts a run signs up", () => {
	it("are each ledgered by the email it sent, and all removed when the document has a delete-self", async () => {
		const { leaked, ledger, raw, result } = await runAgainst()
		/* A session of its own for each destructive operation that ends one: logout, and the delete-self. */
		expect(made(ledger).length).toBeGreaterThanOrEqual(2)
		/* Generated, each carries the run's nonce: no two runs send the same one. */
		for (const email of emails(ledger)) expect(email).toMatch(/^oat-baseline-0-[0-9a-f]{8}\d+@example\.test$/)
		expect(new Set(emails(ledger)).size).toBe(made(ledger).length)
		expect(made(ledger).map((entry) => entry.status)).toEqual(made(ledger).map(() => "removed"))
		expect(leaked).toEqual([])
		expect(raw).not.toMatch(/password|access_token/)
		expect(result.teardown?.failed.filter((failure) => failure.entity === "account")).toEqual([])
	}, 240_000)

	it("are leftovers named by their email, failing the run with 4, when nothing can remove them", async () => {
		const refused = new Set(["profile.delete", "account.delete"])
		const { leaked, ledger, result } = await runAgainst({
			fence: { failRun: false },
			hooks: {
				beforeRequest: (request) =>
					refused.has(request.operationId ?? "") ? { allow: false, reason: "no account deletes" } : { allow: true },
			},
		})
		expect(made(ledger).length).toBeGreaterThanOrEqual(2)
		expect(made(ledger).map((entry) => entry.status)).toEqual(made(ledger).map(() => "left"))
		const left = (result.teardown?.failed ?? []).filter((failure) => failure.entity === "account")
		expect(left.map((failure) => failure.id).sort()).toEqual(emails(ledger).sort())
		expect(leaked.length).toBe(made(ledger).length)
		expect(unreportedLeftovers(leaked, result.teardown)).toEqual([])
		expect(exitCode(result)).toBe(4)
	}, 240_000)
})
