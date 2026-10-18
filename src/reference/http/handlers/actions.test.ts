import { afterEach, describe, expect, it, vi } from "vitest"
import { api, BETA, JOBS, VIEWER } from "../__fixtures__/api.ts"

const START = `${JOBS}/start`
const NOTIFY = "/v1/projects/proj_alpha/notifications"
const INBOX = "/v1/projects/proj_alpha/inbox"

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe("starting a job", () => {
	it("answers a receipt with the job's id, and the job starts pending", async () => {
		vi.spyOn(Date, "now").mockReturnValue(5000)
		const { call } = await api()
		const { status, body } = await call("POST", START, { body: { name: "export" } })
		expect(status).toBe(202)
		expect(body).toEqual({ accepted: true, job_id: "job_000001" })
		expect((await call("GET", `${JOBS}/job_000001`)).body).toMatchObject({ name: "export", status: "pending" })
	})

	it("refuses another tenant, a body that is not JSON, and a missing name", async () => {
		const { call } = await api()
		expect((await call("POST", START, { body: { name: "j" }, token: BETA })).status).toBe(403)
		expect((await call("POST", START, { form: "name=j" })).status).toBe(415)
		expect((await call("POST", START, { body: {} })).status).toBe(400)
		expect((await call("POST", START, { body: { name: "" } })).status).toBe(400)
		expect((await call("POST", "/jobs/start", { body: { name: "j" } })).status).toBe(403)
		expect((await call("GET", START)).status).toBe(404)
	})

	it("crashes under ACTION_CRASHES", async () => {
		const { call } = await api({ defects: ["ACTION_CRASHES"] })
		expect(await call("POST", START, { body: { name: "j" } })).toMatchObject({
			body: { message: "job runner unavailable" },
			status: 500,
		})
	})

	it("answers without the job under EFFECT_NOT_APPLIED, and without its id under ASYNC_RECEIPT_MISSING_ID", async () => {
		const lost = await api({ defects: ["EFFECT_NOT_APPLIED"] })
		expect((await lost.call("POST", START, { body: { name: "j" } })).body.job_id).toBe("job_000001")
		expect((await lost.call("GET", `${JOBS}/job_000001`)).status).toBe(404)
		const anonymous = await api({ defects: ["ASYNC_RECEIPT_MISSING_ID"] })
		expect((await anonymous.call("POST", START, { body: { name: "j" } })).body).toEqual({ accepted: true })
	})
})

describe("a notification", () => {
	it("reaches the project's inbox shortly after it is accepted", async () => {
		vi.useFakeTimers()
		const { call } = await api()
		const { status, body } = await call("POST", NOTIFY, { body: { message: "hi" } })
		expect(status).toBe(202)
		expect(body).toEqual({ accepted: true, notification_id: "ntf_000001" })
		await call("POST", NOTIFY, { body: { message: "again" } })
		expect((await call("GET", INBOX)).body).toEqual({ messages: [] })
		vi.advanceTimersByTime(40)
		expect((await call("GET", INBOX)).body).toEqual({
			messages: [
				{ id: "ntf_000001", message: "hi" },
				{ id: "ntf_000002", message: "again" },
			],
		})
	})

	it("never arrives under SIDE_EFFECT_NEVER_ARRIVES", async () => {
		vi.useFakeTimers()
		const { call } = await api({ defects: ["SIDE_EFFECT_NEVER_ARRIVES"] })
		expect((await call("POST", NOTIFY, { body: { message: "hi" } })).status).toBe(202)
		vi.advanceTimersByTime(1000)
		expect((await call("GET", INBOX)).body).toEqual({ messages: [] })
	})

	it("refuses a viewer, another tenant, and a missing, empty or overlong message", async () => {
		const { call } = await api()
		expect((await call("POST", NOTIFY, { body: { message: "hi" }, token: VIEWER })).status).toBe(403)
		expect((await call("POST", NOTIFY, { body: { message: "hi" }, token: BETA })).status).toBe(403)
		expect((await call("POST", NOTIFY, { form: "message=hi" })).status).toBe(415)
		for (const body of [{}, { message: "" }, { message: "x".repeat(201) }]) {
			expect((await call("POST", NOTIFY, { body })).status).toBe(400)
		}
		expect((await call("GET", NOTIFY)).status).toBe(404)
	})
})

describe("the inbox", () => {
	it("is the caller's own project's alone", async () => {
		const { call } = await api()
		expect((await call("GET", INBOX, { token: BETA })).status).toBe(403)
		expect((await call("GET", INBOX, { token: null })).status).toBe(401)
		expect((await call("POST", INBOX)).status).toBe(404)
	})
})
