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

/** ctx whose n-th dialog receives `keySets[n]` (several questions are several dialogs). */
function ctxSeq(keySets: string[][]): any {
	let n = 0;
	return {
		hasUI: true,
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
					const c = factory({ requestRender() {}, terminal: { rows: 40, columns: 80 } }, theme, {}, resolve);
					for (const k of keySets[n++] ?? []) c.handleInput(k);
				}),
		},
	};
}

const params = { questions: [{ question: "Push?", options: [{ label: "Merge only (Recommended)" }, { label: "Push" }] }] };

test("registers the single question tool, questions in the shared `questions` shape", () => {
	const { tools } = load();
	assert.deepEqual(tools.map((t) => t.name), ["question"]);
	const schema = tools[0].parameters;
	assert.deepEqual(Object.keys(schema.properties), ["questions", "to"]);
	assert.equal(schema.properties.questions.minItems, 1);
	assert.equal(schema.properties.questions.maxItems, 9);
	assert.deepEqual(Object.keys(schema.properties.questions.items.properties), ["question", "header", "options", "multiple"]);
});

const SPACE = " ";
const two = {
	questions: [
		{ question: "Which base?", options: [{ label: "Merge (Recommended)" }, { label: "Only dev" }] },
		{ question: "Which checks?", multiple: true, options: [{ label: "Lint" }, { label: "Tests" }, { label: "Types" }] },
	],
};

test("several questions are one questionnaire dialog (tabs + review), answered in one result", async () => {
	const { tool, events } = load();
	let screen = "";
	const c = ctx([DOWN, ENTER, SPACE, DOWN, DOWN, SPACE, ENTER, ENTER], () => {});
	const open = c.ui.custom;
	c.ui.custom = (factory: any) => open((...args: any[]) => {
		const comp = factory(...args);
		const handle = comp.handleInput.bind(comp);
		comp.handleInput = (k: string) => {
			handle(k);
			screen = comp.render(80).join("\n");
		};
		return comp;
	});
	const result = await tool.execute("t1", two, undefined, undefined, c);
	assert.equal(
		result.content[0].text,
		"[1/2] Which base?\nUser selected: 2. Only dev\n\n[2/2] Which checks?\nUser selected: 1. Lint, 3. Types",
	);
	assert.equal(result.details.question, "2 questions");
	assert.equal(result.details.answer, "Only dev | Lint, Types");
	assert.deepEqual(result.details.results[1].multi, { indexes: [1, 3], labels: ["Lint", "Types"] });
	assert.match(screen, /▣ +Q1\s+▣ +Q2\s+✓ Review/);
	// One dialog, one pending/settled pair, a label that says how many questions there are.
	const pending = events.filter(([n, e]) => n === QUESTION_EVENT && e.pending);
	assert.equal(pending.length, 1);
	assert.equal(pending[0][1].question, "Which base? (+1 more)");
	assert.equal(events.at(-1)?.[1].answer, "Only dev | Lint, Types");
});

test("cancelling the questionnaire cancels every question; no UI never opens it", async () => {
	const { tool, events } = load();
	const result = await tool.execute("t1", two, undefined, undefined, ctx([ENTER, "\x1b"]));
	assert.equal(result.content[0].text, "User cancelled the selection");
	assert.equal(result.details.answer, null);
	assert.equal(result.details.results, undefined);
	assert.equal(events.at(-1)?.[1].answer, null);

	const before = events.length;
	assert.match((await tool.execute("t2", two, undefined, undefined, ctx([], undefined, false))).content[0].text, /UI not available/);
	assert.equal(events.length, before);
});

test("questions for a parent agent are asked one at a time; a cancelled one ends the call", async (t) => {
	t.after(() => setRouter(undefined));
	const asked = router("parent", { kind: "user", reason: "timeout" });
	const { tool, events } = load();
	const result = await tool.execute("t1", two, undefined, undefined, ctxSeq([[ENTER], ["\x1b"]]));
	assert.match(
		result.content[0].text,
		/^\[1\/2\] Which base\?\nUser selected: 1\. Merge \(Recommended\)\n\(the parent agent could not answer \(timeout\): the user answered\)\n\n\[2\/2\] Which checks\?\nUser cancelled the selection/,
	);
	assert.equal(result.details.results.length, 2);
	assert.equal(asked.length, 2);
	assert.deepEqual(asked.map((q: any) => q.multiple), [undefined, true]);
	assert.equal(events.filter(([n, e]) => n === QUESTION_EVENT && e.pending).length, 2);

	const first = await tool.execute("t2", two, undefined, undefined, ctxSeq([["\x1b"]]));
	assert.match(first.content[0].text, /\(1 more question not asked\)$/);
});

test("a multiple-choice question: typed numbers or labels from a remote viewer, free text kept", async () => {
	const { tool } = load();
	const q = (multiple: boolean) => ({ questions: [{ question: "Checks?", multiple, options: [{ label: "Lint" }, { label: "Tests" }, { label: "Types" }] }] });
	assert.equal((await tool.execute("t", q(true), undefined, undefined, ctx(["1,3", ENTER]))).content[0].text, "User selected: 1. Lint, 3. Types");
	assert.equal((await tool.execute("t", q(true), undefined, undefined, ctx(["tests, lint", ENTER]))).content[0].text, "User selected: 1. Lint, 2. Tests");
	assert.equal((await tool.execute("t", q(true), undefined, undefined, ctx([SPACE, "2", ENTER]))).content[0].text, "User selected: 1. Lint, 2. Tests");
	// A single-choice question takes the same text as one option only.
	assert.equal((await tool.execute("t", q(false), undefined, undefined, ctx(["1,3", ENTER]))).content[0].text, "User wrote: 1,3");
});

test("renderCall/renderResult show several questions and several chosen options", async () => {
	const { tool } = load();
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const text = (c: any) => c.render(200).map((l: string) => l.trimEnd()).join("\n");
	const call = text(tool.renderCall(two, theme));
	assert.match(call, /question 2 questions\n\[1\/2\] Which base\?\n {2}Options: 1\. Merge/);
	assert.match(call, /\[2\/2\] Which checks\?\n {2}Options \(several allowed\): 1\. Lint, 2\. Tests, 3\. Types, 4\. Type something\./);
	const result = await tool.execute("t1", two, undefined, undefined, ctx([ENTER, SPACE, DOWN, SPACE, ENTER, ENTER]));
	const shown = text(tool.renderResult(result, {}, theme));
	assert.match(shown, /\[1\/2\] Which base\?\n {2}\u2713 1\. Merge \(Recommended\)\n\[2\/2\] Which checks\?\n {2}\u2713 1\. Lint, 2\. Tests/);
});

test("the pre-0.3 top-level question/options still work (direct callers, old sessions)", async () => {
	const { tool } = load();
	const legacy = { question: "Push?", options: params.questions[0].options };
	const result = await tool.execute("t1", legacy, undefined, undefined, ctx([DOWN, ENTER]));
	assert.equal(result.content[0].text, "User selected: 2. Push");
	const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
	const render = (args: any) => tool.renderCall(args, theme).render(200).join("\n");
	assert.equal(render(legacy), render(params));
	assert.match(render(params), /question Push\?[\s\S]*1\. Merge only \(Recommended\), 2\. Push, 3\. Type something\./);
});

test("a typed answer from a remote viewer (text, then Enter) picks the option", async () => {
	const { tool } = load();
	const result = await tool.execute("t1", params, undefined, undefined, ctx(["2", ENTER]));
	assert.equal(result.content[0].text, "User selected: 2. Push");
	assert.equal(result.details.answer, "Push");
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
	assert.match((await tool.execute("t", { questions: [{ question: "?", options: [] }] }, undefined, undefined, ctx([]))).content[0].text, /No options/);
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
