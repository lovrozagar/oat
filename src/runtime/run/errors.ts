import { messageOf } from "../../errors/message.ts"

/**
 * An unexpected error as a report states it: its message, named when it is not a plain `Error`.
 *
 * Never its stack: a report is shared beyond the machine that ran it, and a stack names oat's own
 * files by absolute path. A path under the working directory is written relative to it.
 */
export function errorText(error: unknown): string {
	const text = error instanceof Error && error.name !== "Error" ? `${error.name}: ${error.message}` : messageOf(error)
	return text.replaceAll(process.cwd(), ".")
}
