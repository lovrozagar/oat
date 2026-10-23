import { UsageError } from "../../errors/usage-error.ts"

/*
 * `postgres` (postgres.js) is an optional peer dependency: only the Postgres reference backend uses
 * it, so an install without it runs every other command, and the Postgres path asks for it by name.
 */

/** The driver range package.json declares as the optional peer (tests/structure/postgres-driver.test.ts). */
export const POSTGRES_RANGE = "^3.4"

/** What a command says, and exits 2 with, when the Postgres backend is asked for on an install without the driver. */
export const MISSING_POSTGRES: string = `oat: --backend postgres needs the postgres package (${POSTGRES_RANGE}): npm install postgres`

/** Whether `error` is Node failing to find the `postgres` package itself, not a module it imports. */
export function isMissingPostgres(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" &&
		error.message.includes("'postgres'")
	)
}

/** What `load` resolves, or a usage error asking for the driver when the install lacks it. */
export async function loadPostgres<T>(load: () => Promise<T>): Promise<T> {
	try {
		return await load()
	} catch (error) {
		if (!isMissingPostgres(error)) throw error
		throw new UsageError(MISSING_POSTGRES, { cause: error })
	}
}
