import { describe, expect, it } from "vitest"
import { FencedError } from "../fence.ts"
import { loaded, notesApi, optionsFor, outage, unreachable } from "./__fixtures__/api.ts"
import { createRunNetwork, requestTimeoutOpt, transportOpt } from "./network.ts"

/*
 * One gate every client waits on, and the outage, noted once: a timeout on a host that still
 * answers is that operation failing, not the network going away.
 */

describe("transportOpt and requestTimeoutOpt", () => {
	it("pass a transport and a timeout only when there is one", async () => {
		const options = optionsFor(notesApi())
		expect(transportOpt(options)).toEqual({ fetchImpl: options.network?.fetch })
		expect(transportOpt({ ...options, network: {} })).toEqual({})
		expect(requestTimeoutOpt(5_000)).toEqual({ requestTimeoutMs: 5_000 })
		expect(requestTimeoutOpt(0)).toEqual({})
	})
})

describe("createRunNetwork", () => {
	it("gives every client the gate, the retries and the transport", async () => {
		const options = optionsFor(notesApi(), { network: { requestTimeoutMs: 1_000, retries: 3 } })
		const network = createRunNetwork(await loaded(options))
		expect(network.client).toMatchObject({ fetchImpl: options.network?.fetch, requestTimeoutMs: 1_000, retries: 3 })
		expect(network.outcome).toBeUndefined()
		/* No wait budget: a request that lost the network gives up at once, and the gate is spent. */
		await expect(network.client.awaitRecovery?.(outage("dns"))).resolves.toBe(false)
		expect(network.gate.exhausted).toBe(true)
		const run = await loaded(options)
		expect(createRunNetwork({ ...run, options: { ...run.options, network: {} } }).client.retries).toBeGreaterThan(0)
	})

	it("notes the first outage only, as a gap where it happened", async () => {
		const run = await loaded(optionsFor(notesApi()))
		const network = createRunNetwork(run)
		await network.note(outage("dns"), "auth")
		await network.note(outage("dns"), "note")
		expect(network.outcome).toMatchObject({ attempts: 1, incomplete: true, kind: "dns", url: "http://api.test/notes" })
		expect(run.findings.findings.map((finding) => [finding.check, finding.entity])).toEqual([
			["net.unreachable", "auth"],
		])
	})

	it("does not take a timeout on a host that still answers for an outage", async () => {
		const run = await loaded(optionsFor(notesApi()))
		const network = createRunNetwork(run)
		await network.note(outage("timeout"), "note")
		expect(network.outcome).toBeUndefined()
	})

	it("takes a timeout on a host that no longer answers for an outage", async () => {
		const run = await loaded(optionsFor(notesApi()))
		const down = createRunNetwork({
			...run,
			options: { ...run.options, network: { fetch: unreachable } },
		})
		await down.note(outage("timeout"), "note")
		expect(down.outcome?.kind).toBe("timeout")
	})

	it("asks the fence before probing the host, and a fenced probe finds it gone", async () => {
		const run = await loaded(optionsFor(notesApi()))
		const refused = new FencedError({ method: "HEAD", phase: "probe", reason: "no probes", url: "http://api.test" })
		const fenced = createRunNetwork({ ...run, fence: { check: () => Promise.reject(refused) } as never })
		await fenced.note(outage("timeout"), "note")
		expect(fenced.outcome?.kind).toBe("timeout")
		const broken = createRunNetwork({ ...run, fence: { check: () => Promise.reject(new Error("bug")) } as never })
		await expect(broken.note(outage("timeout"), "note")).rejects.toThrow("bug")
	})

	it("says on the status line how long it will wait for the network", async () => {
		const messages: string[] = []
		const options = optionsFor(notesApi(), { onProgress: (snap) => messages.push(snap.message ?? "") })
		const run = await loaded(options)
		const down = createRunNetwork({ ...run, options: { ...run.options, network: { fetch: unreachable, waitMs: 60 } } })
		await down.gate.awaitRecovery(outage("dns"))
		expect(messages.at(-1)).toMatch(/^waiting for network \(dns, \d+s left\)$/)
	})
})
