import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { OpenApiDocument } from "../types.ts"
import { bundleLocalRefs } from "./bundle.ts"
import { parseDocument } from "./parse.ts"

/** Where a document is read from, and how a URL is fetched; the caller owns the network. */
export interface SpecSourceOptions {
	baseUrl?: string | undefined
	fetchText?: (url: string) => Promise<string>
	/** The folder a relative path is read from: the config's, for a document a config names. Default the working directory. */
	dir?: string | undefined
}

/**
 * Loads a specification from wherever it lives, in JSON or YAML.
 *
 * Three forms are accepted, resolved in a fixed order so the outcome never depends on a guess
 * about what the string "looks like":
 *
 *   1. an absolute `http(s)://` or `file://` URL — used as given
 *   2. a path that exists on disk — read as a file, relative to `dir` (default the working directory)
 *   3. anything else, when a base URL is known — resolved against it, so `/v1/openapi/spec`
 *      and `openapi.json` both work next to `baseUrl`
 *
 * When none apply the error names every location that was tried, rather than reporting the last
 * failure as though it were the only attempt.
 *
 * A file's relative `$ref`s to other files are read in beside it (`bundleLocalRefs`); a fetched
 * document's are left unfetched, for the caller to report.
 */
export async function loadSpec(source: string, options: SpecSourceOptions = {}): Promise<OpenApiDocument> {
	const { path, text } = await readSpecSource(source, options)
	const doc = await parseDocument(text, source)
	return path === undefined ? doc : bundleLocalRefs(doc, path)
}

/** A document's text, and the file it was read from; no path when it was fetched. */
interface SpecText {
	text: string
	path?: string
}

/* A URL with nothing to fetch it is a caller's mistake: oat's network policy lives in the runtime. */
function fetcher(options: SpecSourceOptions): (url: string) => Promise<string> {
	return (
		options.fetchText ?? ((url) => Promise.reject(new Error(`oat: ${url} is a URL, and this caller reads only files`)))
	)
}

async function readSpecSource(source: string, options: SpecSourceOptions): Promise<SpecText> {
	const { baseUrl } = options
	if (/^https?:\/\//.test(source)) return { text: await fetcher(options)(source) }
	if (source.startsWith("file://")) return readPath(fileURLToPath(source))

	/* A real file wins over a route: a spec checked into the repository is the more specific
	 * intent, and silently fetching instead would hide a typo in the path. */
	const asPath = resolve(options.dir ?? process.cwd(), source)
	try {
		return await readPath(asPath)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
	}

	if (baseUrl !== undefined && baseUrl !== "") {
		return { text: await fetcher(options)(new URL(source, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString()) }
	}

	throw new Error(
		`oat: could not find a specification at "${source}". Tried:\n  ${asPath}` +
			(baseUrl === undefined ? "\nPass --base-url (or set baseUrl in the config) to resolve it as a route." : ""),
	)
}

async function readPath(path: string): Promise<SpecText> {
	return { path, text: await readFile(path, "utf8") }
}
