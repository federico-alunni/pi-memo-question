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
