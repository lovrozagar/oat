/**
 * The page a person opens after a run. Every operation sits in exactly one group, worst first:
 * what failed, what never got a verdict, what passed without its effect being seen, what was
 * verified, and what was complete by its contract alone. Each row says why in one line and links
 * the requests that prove it, so trust in a result never rests on a count.
 */

import type { OperationCoverage, ScopeReport } from "../runtime/scope/types.ts"

export type ConfidenceKey = "failed" | "blocked" | "unproven" | "verified" | "complete"

export interface ConfidenceRow {
	operation: string
	entity: string | null
	why: string
	/** Exchange files behind the row: the call, then the exchange that observed its effect. */
	evidence: string[]
}

export interface ConfidenceGroup {
	key: ConfidenceKey
	title: string
	meaning: string
	rows: ConfidenceRow[]
}

const GROUPS: ReadonlyArray<Omit<ConfidenceGroup, "rows">> = [
	{ key: "failed", meaning: "A check found the backend wrong here.", title: "Failed" },
	{
		key: "blocked",
		meaning: "No verdict: something this operation needed failed first, or no check could reach it.",
		title: "Blocked",
	},
	{
		key: "unproven",
		meaning: "Met its contract, but what it changes was never observed. Add a read that shows the effect.",
		title: "Effects unproven",
	},
	{ key: "verified", meaning: "A later request shows what this call did.", title: "Verified" },
	{
		key: "complete",
		meaning: "A read, or an operation that declares no effects: meeting its contract is all it promises.",
		title: "Complete by contract",
	},
]

function groupOf(op: OperationCoverage): ConfidenceKey {
	if (op.status === "failed") return "failed"
	if (op.status !== "passed") return "blocked"
	return op.sufficiency ?? "unproven"
}

function whyOf(op: OperationCoverage): string {
	if (op.status === "failed") {
		const checks = op.checks.failed.length > 0 ? op.checks.failed.join(", ") : "a check"
		return `failed ${checks} (${op.findings} finding${op.findings === 1 ? "" : "s"})`
	}
	return op.why ?? op.reason ?? "no reason recorded"
}

function evidenceOf(op: OperationCoverage, files: ReadonlyMap<number, string>): string[] {
	if (op.evidence === undefined) return []
	const seqs = [op.evidence.call, ...(op.evidence.observation === undefined ? [] : [op.evidence.observation.seq])]
	return seqs.flatMap((seq) => {
		const file = files.get(seq)
		return file === undefined ? [] : [file]
	})
}

export function confidenceGroups(scope: ScopeReport, files: ReadonlyMap<number, string>): ConfidenceGroup[] {
	return GROUPS.map((group) => ({
		...group,
		rows: scope.operations
			.filter((op) => groupOf(op) === group.key)
			.map((op) => ({
				entity: op.entity,
				evidence: evidenceOf(op, files),
				operation: op.origin === undefined ? op.operationId : `${op.origin}:${op.operationId}`,
				why: whyOf(op),
			}))
			.sort((a, b) => a.operation.localeCompare(b.operation)),
	}))
}

function escape(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

function rowHtml(row: ConfidenceRow): string {
	const links = row.evidence
		.map((file, i) => `<a href="${escape(file)}">${i === 0 ? "call" : "observed"}</a>`)
		.join(" · ")
	return (
		`<tr><td><code>${escape(row.operation)}</code>${row.entity === null ? "" : `<span class="entity">${escape(row.entity)}</span>`}</td>` +
		`<td>${escape(row.why)}</td><td class="links">${links}</td></tr>`
	)
}

const STYLE = `
:root{--bg:#fbfbfa;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3df;--failed:#c0362c;--blocked:#b7791f;--unproven:#8a6d00;--verified:#2f7d4f;--complete:#3a6ea5}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--muted:#9a9a94;--line:#2c2c2a;--failed:#ef6b5f;--blocked:#e3a94a;--unproven:#d8b84a;--verified:#5fbf86;--complete:#78a6dc}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}p.meta{color:var(--muted);margin:0 0 20px}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px}.bar a{display:flex;gap:6px;align-items:baseline;padding:8px 12px;border:1px solid var(--line);border-radius:8px;color:inherit;text-decoration:none}
.bar strong{font-size:20px}section{margin-bottom:28px}h2{font-size:17px;margin:0 0 2px;display:flex;gap:8px;align-items:center}
h2 .dot{width:10px;height:10px;border-radius:50%}p.meaning{color:var(--muted);margin:0 0 8px}
table{width:100%;border-collapse:collapse}td{border-top:1px solid var(--line);padding:6px 8px;vertical-align:top}
td:first-child{width:34%;word-break:break-word}td.links{width:120px;white-space:nowrap}code{font-size:13px}
.entity{display:block;color:var(--muted);font-size:12px}a{color:var(--complete)}
@media (max-width:640px){td{display:block;width:auto!important;border:0;padding:2px 0}tr{display:block;border-top:1px solid var(--line);padding:8px 0}}
`

export function renderConfidenceHtml(
	run: { baseUrl: string; generatedAt: string; scope: ScopeReport },
	files: ReadonlyMap<number, string>,
): string {
	const groups = confidenceGroups(run.scope, files)
	const total = groups.reduce((sum, group) => sum + group.rows.length, 0)
	const bar = groups
		.map(
			(group) =>
				`<a href="#${group.key}"><strong style="color:var(--${group.key})">${group.rows.length}</strong>${escape(group.title)}</a>`,
		)
		.join("")
	const sections = groups
		.filter((group) => group.rows.length > 0)
		.map(
			(group) =>
				`<section id="${group.key}"><h2><span class="dot" style="background:var(--${group.key})"></span>${escape(group.title)} · ${group.rows.length}</h2>` +
				`<p class="meaning">${escape(group.meaning)}</p><table>${group.rows.map(rowHtml).join("")}</table></section>`,
		)
		.join("")
	return (
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
		`<title>oat confidence</title><style>${STYLE}</style></head><body><main>` +
		`<h1>What this run proves</h1><p class="meta">${escape(run.baseUrl)} · ${escape(run.generatedAt)} · ${total} operations · ` +
		`<a href="oat-report.md">full report</a> · <a href="matrix.html">matrix</a></p>` +
		`<nav class="bar">${bar}</nav>${sections}</main></body></html>\n`
	)
}

/** Each request's saved file by its seq, from the journal index (`exchanges.jsonl`). */
export function exchangeFilesFromIndex(index: string): Map<number, string> {
	const files = new Map<number, string>()
	for (const line of index.split("\n")) {
		if (line.trim() === "") continue
		try {
			const entry = JSON.parse(line) as { file?: unknown; seq?: unknown }
			if (typeof entry.seq === "number" && typeof entry.file === "string") files.set(entry.seq, entry.file)
		} catch {
			/* a torn last line from an interrupted run */
		}
	}
	return files
}

/** The markdown report's opening count, one row per group, pointing at the page that lists them. */
export function renderConfidenceMarkdown(scope: ScopeReport): string {
	const groups = confidenceGroups(scope, new Map())
	return [
		"## Confidence",
		"",
		"> Every operation in exactly one group. The rows, with why and the requests behind them: [report.html](./report.html).",
		"",
		"| group | operations | meaning |",
		"| --- | --- | --- |",
		...groups.map((group) => `| ${group.title} | ${group.rows.length} | ${group.meaning} |`),
		"",
	].join("\n")
}
