import test from "node:test";
import assert from "node:assert/strict";
import question from "../extensions/question.ts";
import { QUESTION_EVENT } from "../src/events.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";

function load() {
	const tools: any[] = [];
	const events: [string, any][] = [];
	const pi: any = {
		registerTool: (tool: any) => tools.push(tool),
		events: { emit: (name: string, data: any) => events.push([name, data]) },
	};
	question(pi);
	return { tool: tools[0], tools, events };
}

/** ctx whose dialog receives `keys`, checking events emitted while it is open. */
function ctx(keys: string[], whileOpen?: () => void, hasUI = true): any {
	return {
		hasUI,
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
					const c = factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } }, theme, {}, resolve);
					whileOpen?.();
					for (const k of keys) c.handleInput(k);
				}),
		},
	};
}

const params = { question: "Push?", options: [{ label: "Merge only (Recommended)" }, { label: "Push" }] };

test("registers the single question tool", () => {
	const { tools } = load();
	assert.deepEqual(tools.map((t) => t.name), ["question"]);
});

test("answer: memo-question pending → settled, herdr:blocked around the dialog", async () => {
	const { tool, events } = load();
	let openEvents: [string, any][] = [];
	const result = await tool.execute("t1", params, undefined, undefined, ctx([DOWN, ENTER], () => (openEvents = [...events])));
	assert.equal(result.content[0].text, "User selected: 2. Push");
	assert.deepEqual(result.details, { question: "Push?", options: ["Merge only (Recommended)", "Push"], answer: "Push", wasCustom: false });
	const [pending, blocked] = openEvents;
	assert.equal(pending[0], QUESTION_EVENT);
	assert.deepEqual({ ...pending[1], id: undefined }, { id: undefined, question: "Push?", pending: true });
	assert.deepEqual(blocked, ["herdr:blocked", { active: true, label: "Push?" }]);
	assert.deepEqual(events.slice(2), [
		["herdr:blocked", { active: false }],
		[QUESTION_EVENT, { id: pending[1].id, question: "Push?", pending: false, answer: "Push" }],
	]);
});

test("abort closes the dialog as cancelled; no UI and no options never open it", async () => {
	const { tool, events } = load();
	const abort = new AbortController();
	const result = await tool.execute("t1", params, abort.signal, undefined, ctx([], () => abort.abort()));
	assert.equal(result.content[0].text, "User cancelled the selection");
	assert.equal(result.details.answer, null);
	assert.equal(events.at(-1)?.[1].answer, null);

	const before = events.length;
	assert.match((await tool.execute("t", params, undefined, undefined, ctx([], undefined, false))).content[0].text, /UI not available/);
	assert.match((await tool.execute("t", { question: "?", options: [] }, undefined, undefined, ctx([]))).content[0].text, /No options/);
	assert.equal(events.length, before);
});

import { setRouter } from "../src/router.ts";
import type { QuestionRouter, RouteOutcome } from "../src/router.ts";

function router(defaultTarget: "user" | "parent", outcome: RouteOutcome | (() => Promise<RouteOutcome>)) {
	const asked: any[] = [];
	const r: QuestionRouter = {
		defaultTarget: () => defaultTarget,
		askParent: async (q) => {
			asked.push(q);
			return typeof outcome === "function" ? outcome() : outcome;
		},
	};
	setRouter(r);
	return asked;
}

test("to: parent is answered by the router without the dialog or question events", async (t) => {
	t.after(() => setRouter(undefined));
	const asked = router("user", { kind: "answered", answer: { answer: "Push", custom: false, index: 2 }, by: "the parent agent", note: "tests are green" });
	const { tool, events } = load();
	const result = await tool.execute("t1", { ...params, to: "parent" }, undefined, undefined, { hasUI: false, ui: {} });
	assert.equal(result.content[0].text, "The parent agent selected: 2. Push\nNote: tests are green");
	assert.equal(result.details.answeredBy, "the parent agent");
	assert.equal(result.details.answer, "Push");
	assert.equal(asked[0].question, "Push?");
	assert.deepEqual(events, []);
});

test("the router's default target applies without `to`; `to: user` always opens the dialog", async (t) => {
	t.after(() => setRouter(undefined));
	const asked = router("parent", { kind: "answered", answer: { answer: "free", custom: true }, by: "the parent agent" });
	const { tool } = load();
	assert.equal((await tool.execute("t1", params, undefined, undefined, ctx([]))).content[0].text, "The parent agent wrote: free");
	const user = await tool.execute("t2", { ...params, to: "user" }, undefined, undefined, ctx([ENTER]));
	assert.equal(user.content[0].text, "User selected: 1. Merge only (Recommended)");
	assert.equal(asked.length, 1);
});

test("a parent that cannot answer falls back to the user's dialog, and says so", async (t) => {
	t.after(() => setRouter(undefined));
	router("parent", { kind: "user", reason: "timeout" });
	const { tool, events } = load();
	const result = await tool.execute("t1", params, undefined, undefined, ctx([ENTER]));
	assert.equal(result.content[0].text, "User selected: 1. Merge only (Recommended)\n(the parent agent could not answer (timeout): the user answered)");
	assert.equal(events[0][0], QUESTION_EVENT);
});

test("without a router `to: parent` asks the user", async () => {
	const { tool } = load();
	const result = await tool.execute("t1", { ...params, to: "parent" }, undefined, undefined, ctx([ENTER]));
	assert.match(result.content[0].text, /^User selected: 1\..*\n\(no parent agent to ask: the user answered\)$/);
});

test("a withdrawn parent question is cancelled", async (t) => {
	t.after(() => setRouter(undefined));
	router("parent", { kind: "cancelled" });
	const { tool } = load();
	const result = await tool.execute("t1", params, undefined, undefined, ctx([]));
	assert.match(result.content[0].text, /withdrawn/);
	assert.equal(result.details.answer, null);
});

test("the extension publishes its dialog for hosts", async () => {
	load();
	const api = (globalThis as any)[Symbol.for("pi-memo-question/dialog")];
	assert.equal(typeof api.questionComponent, "function");
});
