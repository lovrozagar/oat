/**
 * The command line or config asked for something that cannot be: an overlay patching an operation
 * the document lacks, a grammar oat cannot read, a target that names nothing. Nothing has run, and
 * the CLI exits with `EXIT.usage` naming the mistake.
 */
export class UsageError extends Error {
	override name = "UsageError"
}
