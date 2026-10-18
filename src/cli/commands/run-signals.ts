import type { Writer } from "../writer.ts"

/** How the run is stopped from outside, and which signal did it. */
export interface RunStop {
	signal: AbortSignal
	/** The signal that stopped the run, when one did. */
	by(): NodeJS.Signals | undefined
	/** Stops listening; the run is over. */
	dispose(): void
}

/** What a process signal does: here, the process itself; in a test, a stand-in. */
export interface SignalSource {
	on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
	off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown
	exit(code: number): never
}

/**
 * Ctrl-C stops testing, not the run: what oat created is still removed and the partial report is
 * still written. A second signal means "now", and exits without either.
 */
export function stopOnSignal(writer: Writer, source: SignalSource = process): RunStop {
	const stop = new AbortController()
	let first: NodeJS.Signals | undefined
	const onSignal = (signal: NodeJS.Signals): void => {
		if (stop.signal.aborted) {
			writer.err(`\noat: ${signal} again — exiting without teardown\n`)
			source.exit(130)
		}
		writer.err(`\noat: ${signal} — stopping, removing what this run created (again to exit now)\n`)
		first = signal
		stop.abort()
	}
	source.on("SIGINT", onSignal)
	source.on("SIGTERM", onSignal)
	return {
		by: () => first,
		dispose: () => {
			source.off("SIGINT", onSignal)
			source.off("SIGTERM", onSignal)
		},
		signal: stop.signal,
	}
}

/** The shell's exit code for a run a signal stopped. */
export function signalExit(signal: NodeJS.Signals): number {
	return signal === "SIGINT" ? 130 : 143
}
