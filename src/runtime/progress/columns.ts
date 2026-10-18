/**
 * The progress columns, as the TSV header names them and the glossary explains them.
 *
 * Logs are logfmt (key=value, one event per line) — the usual shape for
 * machines and people. Values are never truncated: a fixed-width table
 * forced "…" on check names and URLs, and wrapped the header in a normal
 * editor so the columns stopped lining up.
 *
 * stderr and progress.log are the same format. progress.jsonl is the same
 * events as JSON. progress.tsv is the same columns, tab-separated.
 */

export const PROGRESS_TSV_HEADER: string = /* @__PURE__ */ [
	"ts_ms",
	"status",
	"done",
	"total",
	"phase",
	"entity",
	"check",
	"msg",
	"req",
	"find",
	"method",
	"path",
	"http",
	"req_id",
	"last_at",
	"last_ms",
	"req_b",
	"res_b",
	"idle_ms",
	"elapsed_ms",
].join("\t")

export const PROGRESS_GLOSSARY: string = /* @__PURE__ */ [
	"# logfmt — one event per line, full values, no truncation",
	"# ts               when this line was written (ISO-8601 UTC). ts_ms is the same instant as unix ms",
	"# status=ok|stall|in_flight|network  in_flight = on the wire; stall = idle after a completed call; network = fetch threw (offline/dns/reset/…)",
	"# done/total       entity index / how many entities",
	"# phase            load|auth|seed|test|scenario|contract|teardown|done (teardown only while records are removed)",
	"# check            check id (empty when not in a check)",
	"# msg              phase note (seeding, spec URL, teardown count). Not set to in-flight — that is status",
	"# req_id           x-request-id / request-id / x-correlation-id / correlation-id on that call (empty if none)",
	"# last_at          wall clock of that call (ISO-8601 UTC). While in_flight, when fetch started",
	"# last_ms          duration of the last completed HTTP call. Empty (-) while in_flight",
	"# req_b / res_b    reconstructed HTTP/1.1 size (start line + headers + body) of that call. res_b is empty while in_flight",
	"# idle_ms          while in_flight: ms since this request started. otherwise ms since the last call returned",
	"# elapsed_ms       wall clock since oat started",
].join("\n")
