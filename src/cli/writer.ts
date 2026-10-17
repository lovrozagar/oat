/*
 * The one owner of terminal output. Everything oat prints goes through a writer, so a command can
 * be run with its output captured, and the progress line and the report never interleave.
 */

export interface Writer {
	/** Results: the report summary, `plan`, `doctor`, help. */
	out(text: string): void
	/** Diagnostics: progress, warnings, refusals. */
	err(text: string): void
	/** Pushes out what is buffered: a piped stdout holds text until exit unless asked. */
	flush(): void
}

/** The process's own streams, read at each write so a test that replaces them sees every line. */
export const processWriter: Writer = {
	err: (text) => {
		process.stderr.write(text)
	},
	flush: () => {
		process.stdout.uncork()
	},
	out: (text) => {
		process.stdout.write(text)
	},
}

/** A writer that keeps everything it is given, in order, for a caller that prints it later. */
export function bufferWriter(): Writer & { text: () => string } {
	const chunks: string[] = []
	return {
		err: (text) => chunks.push(text),
		flush: () => undefined,
		out: (text) => chunks.push(text),
		text: () => chunks.join(""),
	}
}
