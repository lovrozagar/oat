/** A Postgres for unit tests: a connection port that records statements instead of opening a socket. */

import type { Row } from "../../store-api.ts"
import type { PgConnect } from "../postgres.ts"
import type { SqlParam } from "../sql-compile.ts"

export interface Statement {
	database: string
	query: string
	args?: SqlParam[]
}

export interface FakePostgres {
	connect: PgConnect
	/* Every session ended, in order, with the timeout it was given. */
	ended: Array<{ database: string; timeout: number }>
	statements: Statement[]
}

/** Records every statement and answers each from `answer`, by database and text. */
export function fakePostgres(answer: (statement: Statement) => Row[] = () => []): FakePostgres {
	const statements: Statement[] = []
	const ended: FakePostgres["ended"] = []
	const connect: PgConnect = (database) => ({
		end: async ({ timeout }) => {
			ended.push({ database, timeout })
		},
		unsafe: async (query, args) => {
			const statement = args === undefined ? { database, query } : { args, database, query }
			statements.push(statement)
			return answer(statement)
		},
	})
	return { connect, ended, statements }
}
