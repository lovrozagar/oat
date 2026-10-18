import type { ReferenceOptions, ReferenceServer } from "../../reference/http.ts"
import { type Args, str } from "../flags.ts"
import type { Writer } from "../writer.ts"

type Factory = (options: ReferenceOptions) => Promise<Pick<ReferenceServer, "close" | "url">>

/** What `serve` needs from outside: the server factory for a store, and the signal to stop. */
export interface ServeDeps {
	factoryFor(backend: string): Promise<Factory>
	/** Resolves when the process is asked to stop. */
	stopped(): Promise<void>
}

/** The reference backend's factory for `backend`'s store; the in-memory one for any other name. */
export async function referenceFactory(backend: string): Promise<Factory> {
	const { createMemoryServer, createPostgresServer, createSqliteServer } = await import("../../reference/http.ts")
	return backend === "sqlite" ? createSqliteServer : backend === "postgres" ? createPostgresServer : createMemoryServer
}

/** SIGINT or SIGTERM: the server stays up until then. */
export function untilSignal(): Promise<void> {
	return new Promise<void>((stop) => {
		const done = (): void => {
			process.off("SIGINT", done)
			process.off("SIGTERM", done)
			stop()
		}
		process.on("SIGINT", done)
		process.on("SIGTERM", done)
	})
}

const PROCESS: ServeDeps = { factoryFor: referenceFactory, stopped: untilSignal }

/**
 * `oat serve`: a built-in demo API so oat can be tried before wiring it to anything real. The
 * reference backend doubles as the conformance fixture, so this is the same server the self-test
 * runs against. `--untagged` serves it behind a document stripped of every x-* tag — what `oat
 * doctor` should be pointed at to see what a plain OpenAPI document costs.
 */
export async function commandServe(writer: Writer, flags: Args["flags"], deps: ServeDeps = PROCESS): Promise<number> {
	const backend = str(flags, "backend") ?? "memory"
	const defects = str(flags, "defects")?.split(",").filter(Boolean) ?? []
	const untagged = flags.untagged === true
	const dialect = str(flags, "dialect")
	const factory = await deps.factoryFor(backend)
	const server = await factory({ defects, untagged, ...(dialect === undefined ? {} : { dialect }) })
	writer.out(
		`\n  oat demo API — ${backend}${untagged ? " (untagged spec)" : ""}\n` +
			`  url      ${server.url}\n` +
			`  spec     ${server.url}/v1/openapi/spec\n` +
			`  dialect  ${dialect ?? "postgrest"}\n` +
			`  defects  ${defects.length > 0 ? defects.join(", ") : "none — a correct backend"}\n` +
			`  keys     key_alpha (proj_alpha) · key_beta (proj_beta)\n\n` +
			"  point a config at it:\n" +
			`    oat run --config labs/local.config.ts --base-url ${server.url}\n\n` +
			"  ctrl-c to stop\n\n",
	)
	/* Node buffers stdout when it is not a TTY, so a piped `oat serve` would print nothing until
	 * exit — indistinguishable from a hang. */
	writer.flush()
	await deps.stopped()
	await server.close()
	return 0
}
