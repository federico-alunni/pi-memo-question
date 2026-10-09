import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { visibleWidth } from "@earendil-works/pi-tui";
import question from "../extensions/question.ts";
import { ask, askComponent, ASK_AUDIENCE, DEFAULT_GUARD_MS, FREE_ANSWER } from "../src/ask.ts";
import type { AskRequest, AskResult } from "../src/ask.ts";
import { QUESTION_EVENT } from "../src/events.ts";
import { setRouter } from "../src/router.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const SHIFT_DOWN = "\x1b[1;2B";
const PGDN = "\x1b[6~";
const END = "\x1b[F";
const HOME = "\x1b[H";
const TAB = "\t";
const SPACE = " ";
const ENTER = "\r";
const ESC = "\x1b";
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

/** A terminal whose size can change between renders. */
function terminal(columns = 80, rows = 40) {
	return { requestRender() {}, terminal: { rows, columns } } as any;
}

/** ask() with a TUI ctx: `drive` gets the open component and types keys; returns result and events. */
async function run(request: AskRequest, drive: (d: Driver) => void | Promise<void>, signal?: AbortSignal) {
	const events: [string, any][] = [];
	const pi: any = { events: { emit: (name: string, data: any) => events.push([name, data]) } };
	const tui = terminal();
	let driver: Driver | undefined;
	let failure: unknown;
	const ctx: any = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					const c = factory(tui, theme, {}, resolve);
					driver = new Driver(c, tui, events);
					(async () => drive(driver!))().catch((error) => {
						failure = error;
						resolve(null);
					});
				}),
		},
	};
	const result = await ask(ctx, request, { signal, pi });
	if (failure) throw failure;
	return { result, events, driver: driver! };
}

class Driver {
	c: any;
	tui: any;
	events: [string, any][];
	constructor(c: any, tui: any, events: [string, any][]) {
		this.c = c;
		this.tui = tui;
		this.events = events;
	}
	type(...keys: string[]) {
		for (const k of keys) this.c.handleInput(k);
	}
	screen(width = 80) {
		return this.c.render(width).join("\n");
	}
}

const q = (id: string, extra: Partial<AskRequest["questions"][number]> = {}) => ({
	id,
	title: `Question ${id}?`,
	options: [{ label: `${id} yes (Recommended)` }, { label: `${id} no` }],
	...extra,
});

const longBody = Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of the evidence, a little long to wrap at small widths`).join("\n\n");

test("render stays within width and height, follows resize; a long body scrolls with ↑/↓ PgDn End Home", () => {
	const tui = terminal(60, 20);
	const c = askComponent(
		tui,
		theme,
		{ questions: [q("a", { context: ["repo: federico-alunni/pi-issue-round", "739e432 → main ".repeat(10)], body: longBody })] },
		() => {},
	);
	const check = (width: number) => {
		const lines = c.render(width);
		assert.ok(lines.length <= tui.terminal.rows, `${lines.length} lines > ${tui.terminal.rows} rows`);
		for (const l of lines) assert.ok(visibleWidth(l) <= width, `too wide: ${l}`);
		return lines.join("\n");
	};
	let screen = check(60);
	// Title, context and options stay; the body shows a window and its position.
	assert.match(screen, /Question a\?/);
	assert.match(screen, /repo: federico-alunni\/pi-issue-round/);
	assert.match(screen, /> 1\. a yes \(Recommended\)/);
	assert.match(screen, /3\. Type something\./);
	assert.match(screen, /Line 1 of/);
	assert.match(screen, /lines 1-\d+ of \d+/);
	assert.match(screen, /↑↓ PgUp\/PgDn scroll • 1-9 ⇧↑↓ choose/);
	// ↓ scrolls (the option stays), PgDn by a page, End to the bottom, Home back.
	c.handleInput(DOWN);
	screen = check(60);
	assert.doesNotMatch(screen, /Line 1 of/);
	assert.match(screen, /> 1\. a yes/);
	c.handleInput(PGDN);
	assert.match(check(60), /lines \d+-\d+ of/);
	c.handleInput(END);
	screen = check(60);
	assert.match(screen, /Line 80 of/);
	c.handleInput(HOME);
	assert.match(check(60), /Line 1 of/);
	// Options are chosen with Shift+↓ or digits while ↑/↓ scroll.
	c.handleInput(SHIFT_DOWN);
	assert.match(check(60), /> 2\. a no/);
	c.handleInput("3");
	assert.match(check(60), /> 3\. Type something\./);
	// Resize: recomputed at every render, never beyond the terminal.
	tui.terminal.rows = 12;
	check(30);
	tui.terminal.rows = 60;
	check(120);
	tui.terminal.rows = 4;
	check(10);
	tui.terminal.rows = 200; // the body fits: no scrolling, ↑/↓ choose again
	screen = check(200);
	assert.match(screen, /↑↓ navigate/);
	assert.doesNotMatch(screen, /lines \d+-\d+ of/);
	c.handleInput(UP);
	assert.match(check(200), /> 2\. a no/);
});

test("many options in a short terminal: a window around the cursor", () => {
	const tui = terminal(40, 10);
	const options = Array.from({ length: 30 }, (_, i) => ({ label: `opt ${i + 1}`, description: `desc ${i + 1}` }));
	const c = askComponent(tui, theme, { questions: [{ id: "x", title: "Pick", options }] }, () => {});
	for (let i = 0; i < 20; i++) c.handleInput(DOWN);
	const lines = c.render(40);
	assert.ok(lines.length <= 10);
	assert.match(lines.join("\n"), /> 21\. opt 21/);
	assert.match(lines.join("\n"), /↑ \d+ more/);
});

test("several questions: ←/→ move between them with an indicator; Enter answers and advances", async () => {
	const { result, driver } = await run({ questions: [q("a"), q("b"), q("c")] }, (d) => {
		const screen = d.screen();
		assert.match(screen, /1\/3 {2}\[1\] 2 3/);
		assert.match(screen, /←→ questions/);
		assert.match(screen, /Esc to cancel\s+all/);
		d.type(RIGHT);
		assert.match(d.screen(), /2\/3/);
		assert.match(d.screen(), /Question b\?/);
		d.type(LEFT, DOWN, ENTER); // a: no → goes to b
		assert.match(d.screen(), /2\/3 {2}✓1 \[2\] 3/);
		d.type(ENTER); // b: yes → c
		d.type(RIGHT); // last page, nothing after it
		assert.match(d.screen(), /3\/3/);
		d.type(DOWN, DOWN, ENTER, ..."later", ENTER); // c: free answer
	});
	assert.deepEqual(result, {
		status: "answered",
		answers: {
			a: { indices: [1], labels: ["a no"] },
			b: { indices: [0], labels: ["b yes (Recommended)"] },
			c: { indices: [], labels: [], custom: "later" },
		},
	});
	assert.ok(driver);
});

test("Esc on any page cancels the whole dialog; Esc in the editor only closes the editor", async () => {
	const { result, events } = await run({ questions: [q("a"), q("b")] }, (d) => {
		d.type(ENTER); // a answered
		d.type(TAB); // note editor on b
		d.type(ESC); // back to the options
		assert.doesNotMatch(d.screen(), /Add note/);
		d.type(ESC);
	});
	assert.deepEqual(result, { status: "cancelled" });
	assert.equal(events.at(-1)?.[1].answer, null);
});

test("review depends on the answers: null means no confirmation; the initial option comes preselected", async () => {
	const review = (answers: any) =>
		answers.a.indices[0] === 0
			? {
					title: "Close the selected issues?",
					context: ["abc1234 → main"],
					body: "- #1\n- #2",
					options: [{ label: "Yes" }, { label: "No" }],
					initial: 1,
				}
			: null;
	const request = { questions: [q("a", { freeAnswer: false, notes: false })], review, guardMs: 0 };

	const confirmed = await run(request, (d) => {
		d.type(ENTER);
		const screen = d.screen();
		assert.match(screen, /Close the selected issues\?/);
		assert.match(screen, /abc1234 → main/);
		assert.match(screen, /> 2\. No/);
		assert.match(screen, /\[Review\]/);
		d.type(LEFT); // back to the question, then forward again
		assert.match(d.screen(), /Question a\?/);
		d.type(RIGHT);
		d.type(UP, ENTER);
	});
	assert.deepEqual(confirmed.result, {
		status: "answered",
		answers: { a: { indices: [0], labels: ["a yes (Recommended)"] } },
		review: { index: 0, label: "Yes" },
	});

	const safe = await run(request, (d) => d.type(ENTER, ENTER));
	assert.deepEqual((safe.result as any).review, { index: 1, label: "No" });

	const none = await run(request, (d) => d.type(DOWN, ENTER)); // review(answers) → null
	assert.deepEqual(none.result, { status: "answered", answers: { a: { indices: [1], labels: ["a no"] } } });
});

test("multiSelect: preselection, Space toggles, Enter confirms; a note can be attached", async () => {
	const options = [{ label: "#1" }, { label: "#2" }, { label: "#3" }];
	const { result } = await run({ questions: [{ id: "m", title: "Which issues?", options, multiSelect: true, initial: [0, 2] }] }, (d) => {
		const screen = d.screen();
		assert.match(screen, /> \[x\] 1\. #1\n {2}\[ \] 2\. #2\n {2}\[x\] 3\. #3/);
		assert.match(screen, /Space to toggle • Enter to confirm/);
		d.type(SPACE); // uncheck #1
		d.type(DOWN, SPACE); // check #2
		d.type(TAB, ..."only these", ENTER);
	});
	assert.deepEqual(result, { status: "answered", answers: { m: { indices: [1, 2], labels: ["#2", "#3"], note: "only these" } } });
});

test("freeAnswer: false and notes: false: no 'Type something.', Tab does nothing", async () => {
	const { result } = await run({ questions: [q("a", { freeAnswer: false, notes: false })], guardMs: 0 }, (d) => {
		const screen = d.screen();
		assert.doesNotMatch(screen, /Type something/);
		assert.doesNotMatch(screen, /Tab/);
		d.type(DOWN, DOWN, DOWN); // stops at the last option
		d.type(TAB);
		assert.doesNotMatch(d.screen(), /Add note/);
		d.type(ENTER);
	});
	assert.deepEqual(result, { status: "answered", answers: { a: { indices: [1], labels: ["a no"] } } });
	assert.equal(FREE_ANSWER, "Type something.");
});

test("guardMs: Enter right after opening is ignored (default for consent questions)", async () => {
	const consent = { questions: [q("a", { freeAnswer: false })] };
	const { result } = await run({ ...consent, guardMs: 40 }, async (d) => {
		d.type(ENTER); // a key left in the buffer
		assert.match(d.screen(), /Question a\?/);
		await sleep(60);
		d.type(DOWN, ENTER);
	});
	assert.deepEqual(result, { status: "answered", answers: { a: { indices: [1], labels: ["a no"] } } });
	// Default: DEFAULT_GUARD_MS for freeAnswer: false (Enter ignored, Esc still cancels).
	assert.ok(DEFAULT_GUARD_MS >= 500);
	const guarded = await run(consent, (d) => d.type(ENTER, ENTER, ESC));
	assert.deepEqual(guarded.result, { status: "cancelled" });
	// The review page has its own guard from when it opens.
	const reviewed = await run(
		{ questions: [q("a")], review: { title: "Sure?", options: [{ label: "Yes" }, { label: "No" }] }, guardMs: 40 },
		async (d) => {
			await sleep(60);
			d.type(ENTER); // answers a, opens the review
			d.type(ENTER); // ignored
			assert.match(d.screen(), /Sure\?/);
			await sleep(60);
			d.type(ENTER);
		},
	);
	assert.deepEqual((reviewed.result as any).review, { index: 0, label: "Yes" });
});

test("initial other than 0 preselects that option", async () => {
	const { result } = await run({ questions: [{ ...q("a"), options: [{ label: "x" }, { label: "y" }, { label: "z" }], initial: 2 }] }, (d) => {
		assert.match(d.screen(), /> 3\. z/);
		d.type(ENTER);
	});
	assert.deepEqual(result, { status: "answered", answers: { a: { indices: [2], labels: ["z"] } } });
});

test("abort closes the dialog as aborted; the settled event still arrives with the pending id", async () => {
	const abort = new AbortController();
	const { result, events } = await run({ questions: [q("a")] }, () => abort.abort(), abort.signal);
	assert.deepEqual(result, { status: "aborted" });
	const memo = events.filter(([n]) => n === QUESTION_EVENT).map(([, e]) => e);
	assert.equal(memo.length, 2);
	assert.equal(memo[1].id, memo[0].id);
	assert.deepEqual(memo[1], { id: memo[0].id, question: "Question a?", pending: false, answer: null });
	// Already aborted: nothing opens.
	assert.deepEqual(await ask({ hasUI: true, ui: { custom: () => assert.fail("opened") } } as any, { questions: [q("a")] }, { signal: abort.signal }), {
		status: "aborted",
	});
});

test("events: memo-question pending/settled with one unique id, herdr:blocked around the dialog", async () => {
	const request = { title: "Close issues", questions: [q("a"), q("b")], audience: "user" as const };
	let open: [string, any][] = [];
	const { result, events } = await run(request, (d) => {
		open = [...d.events];
		d.type(ENTER, DOWN, ENTER);
	});
	assert.equal(result.status, "answered");
	const [pending, blocked] = open;
	assert.equal(pending[0], QUESTION_EVENT);
	assert.match(pending[1].id, /^[0-9a-f-]{36}$/);
	assert.deepEqual(pending[1], { id: pending[1].id, question: "Close issues", pending: true, audience: "user" });
	assert.deepEqual(blocked, ["herdr:blocked", { active: true, label: "Close issues" }]);
	assert.deepEqual(events.slice(2), [
		["herdr:blocked", { active: false }],
		[QUESTION_EVENT, { id: pending[1].id, question: "Close issues", pending: false, answer: "a yes (Recommended) | b no", audience: "user" }],
	]);
	const again = await run(request, (d) => d.type(ESC));
	assert.notEqual(again.events[0][1].id, pending[1].id);
});

test("fallback without custom UI: one select per question, same options and order, initial first, readable text", async () => {
	const calls: { title: string; options: string[] }[] = [];
	const picks = ["c", "[ ] b2", "Done (2 selected)", "No"];
	const ctx: any = {
		hasUI: true,
		mode: "rpc",
		ui: {
			custom: () => assert.fail("no custom UI in RPC"),
			select: async (title: string, options: string[]) => {
				calls.push({ title, options });
				return picks.shift();
			},
			input: async () => assert.fail("no free answer here"),
		},
	};
	const result = await ask(ctx, {
		questions: [
			{ id: "one", title: "Which?", context: ["repo: x/y"], body: "**Evidence**\n\n- a", options: [{ label: "a", description: "first" }, { label: "b" }, { label: "c" }], initial: 2, freeAnswer: false },
			{ id: "many", title: "Which ones?", options: [{ label: "b1" }, { label: "b2" }], multiSelect: true, initial: [0] },
		],
		review: { title: "Confirm?", options: [{ label: "Yes" }, { label: "No" }], initial: 1 },
	});
	assert.deepEqual(calls[0], { title: "(1/2) Which?\n\nrepo: x/y\n\n**Evidence**\n\n- a", options: ["c", "a — first", "b"] });
	assert.deepEqual(calls[1].options, ["Done (1 selected)", "[x] b1", "[ ] b2", "Type something."]);
	assert.deepEqual(calls[2].options, ["Done (2 selected)", "[x] b1", "[x] b2", "Type something."]);
	assert.equal(calls[1].title, "(2/2) Which ones?");
	assert.deepEqual(calls[3], { title: "Confirm?", options: ["No", "Yes"] });
	for (const c of calls) assert.doesNotMatch(c.title, /[{}"]/);
	assert.deepEqual(result, {
		status: "answered",
		answers: { one: { indices: [2], labels: ["c"] }, many: { indices: [0, 1], labels: ["b1", "b2"] } },
		review: { index: 1, label: "No" },
	});

	// custom missing, returning undefined or throwing → select; the free answer goes through ctx.ui.input.
	for (const custom of [undefined, async () => undefined, async () => { throw new Error("no TUI"); }]) {
		const r = await ask(
			{ hasUI: true, ui: { custom, select: async (_t: string, o: string[]) => o.at(-1), input: async () => " my text " } } as any,
			{ questions: [q("a")] },
		);
		assert.deepEqual(r, { status: "answered", answers: { a: { indices: [], labels: [], custom: "my text" } } });
	}
	// Cancelled select, no UI at all: cancelled with a reason, never an exception.
	assert.deepEqual(await ask({ hasUI: true, mode: "rpc", ui: { select: async () => undefined } } as any, { questions: [q("a")] }), { status: "cancelled" });
	const none = await ask({ hasUI: false } as any, { questions: [q("a")] });
	assert.equal(none.status, "cancelled");
	assert.match((none as any).reason, /no UI/);
	assert.match((await ask({ hasUI: true, ui: {} } as any, { questions: [q("a")] }) as any).reason, /no dialog UI/);
	assert.match((await ask(undefined as any, { questions: [q("a")] }) as any).reason, /no UI/);
	assert.match((await ask({ hasUI: true, ui: {} } as any, { questions: [] }) as any).reason, /invalid request/);
	// Without ctx.ui.input the free answer is not offered.
	const offered: string[][] = [];
	await ask({ hasUI: true, mode: "rpc", ui: { select: async (_t: string, o: string[]) => (offered.push(o), o[0]) } } as any, { questions: [q("a")] });
	assert.deepEqual(offered, [["a yes (Recommended)", "a no"]]);
});

test("a review callback that throws, or a review without options, cancels with a reason", async () => {
	const thrown = await run({ questions: [q("a")], guardMs: 0, review: () => { throw new Error("boom"); } }, (d) => d.type(ENTER));
	assert.deepEqual(thrown.result, { status: "cancelled", reason: "review failed: boom" });
	const empty = await run({ questions: [q("a")], guardMs: 0, review: () => ({ title: "?", options: [] }) }, (d) => d.type(ENTER));
	assert.deepEqual(empty.result, { status: "cancelled", reason: "review without options" });
	assert.match((await ask({ hasUI: true, ui: {} } as any, { questions: [q("a")], review: { title: "?", options: [] } }) as any).reason, /review without options/);
});

// --- audience: "user" --------------------------------------------------------------------------------
// pi-memo-subagents routes a question to the parent agent by wrapping the `question` tool's execute and
// replacing ctx.ui.custom with a function that returns the parent's answer (a QuestionAnswer) without
// running the dialog. ask() is called by extension code with pi's own ctx, so it is not routed; and with
// audience "user" any answer not produced by this dialog's key handling is refused.

/** ctx.ui.custom as pi-memo-subagents' ask-parent replaces it: the parent answered, the factory never runs. */
function routedCtx(seen: any[]): any {
	return {
		hasUI: true,
		ui: {
			custom: async (factory: any) => {
				seen.push(factory[ASK_AUDIENCE]);
				return { answer: "a no", custom: false, index: 2 };
			},
		},
	};
}

test("audience user: an answer injected by a router replacing ctx.ui.custom is refused; the factory carries the audience", async () => {
	const seen: any[] = [];
	const refused = await ask(routedCtx(seen), { questions: [q("a")], audience: "user" });
	assert.equal(refused.status, "cancelled");
	assert.match((refused as any).reason, /audience: user/);
	// Default audience (the question tool): routing keeps working as with 0.1.0.
	const routed = await ask(routedCtx(seen), { questions: [q("a")] });
	assert.deepEqual(routed, { status: "answered", answers: { a: { indices: [1], labels: ["a no"] } } });
	assert.deepEqual(seen, ["user", "any"]);
	// A fabricated result object is not a dialog result either.
	const fake: AskResult = { status: "answered", answers: { a: { indices: [0], labels: ["a yes (Recommended)"] } } };
	const forged = await ask({ hasUI: true, ui: { custom: async () => fake } } as any, { questions: [q("a")], audience: "user" });
	assert.equal(forged.status, "cancelled");
});

test("ask() never consults the question router, even when the session's default target is the parent", async (t) => {
	const asked: any[] = [];
	setRouter({ defaultTarget: () => "parent", askParent: async (rq) => (asked.push(rq), { kind: "answered", answer: null, by: "the parent agent" }) });
	t.after(() => setRouter(undefined));
	for (const audience of ["user", undefined] as const) {
		const { result } = await run({ questions: [q("a")], ...(audience ? { audience } : {}) }, (d) => d.type(DOWN, ENTER));
		assert.deepEqual(result, { status: "answered", answers: { a: { indices: [1], labels: ["a no"] } } });
	}
	assert.deepEqual(asked, []);
});

test("question tool: when the parent cannot answer, the user's dialog uses the router question's id", async (t) => {
	const ids: string[] = [];
	setRouter({ defaultTarget: () => "parent", askParent: async (rq) => (ids.push(rq.id), { kind: "user", reason: "timeout" }) });
	t.after(() => setRouter(undefined));
	const { tool: tq, events } = tool();
	const r = await tq.execute("t", params, undefined, undefined, toolCtx([ENTER]));
	assert.match(r.content[0].text, /^User selected: 1\. Merge only \(Recommended\)\n\(the parent agent could not answer \(timeout\)/);
	const memo = events.filter(([n]) => n === QUESTION_EVENT).map(([, e]) => e.id);
	assert.deepEqual(memo, [ids[0], ids[0]]);
});

// --- the question tool -------------------------------------------------------------------------------

function tool() {
	const tools: any[] = [];
	const events: [string, any][] = [];
	question({ registerTool: (t: any) => tools.push(t), events: { emit: (n: string, d: any) => events.push([n, d]) } } as any);
	return { tool: tools[0], events };
}

function toolCtx(keys: string[]): any {
	return {
		hasUI: true,
		ui: {
			custom: (factory: any) =>
				new Promise((resolve) => {
					const c = factory(terminal(), theme, {}, resolve);
					for (const k of keys) c.handleInput(k);
				}),
		},
	};
}

const params = { question: "Push?", options: [{ label: "Merge only (Recommended)" }, { label: "Push" }] };

test("question tool: result texts and details unchanged", async () => {
	const { tool: t } = tool();
	const cases: [string[], string, any][] = [
		[[DOWN, ENTER], "User selected: 2. Push", { answer: "Push", wasCustom: false }],
		[[TAB, ..."docs", ENTER], "User selected: 1. Merge only (Recommended)\nUser note: docs", { answer: "Merge only (Recommended)", wasCustom: false, note: "docs" }],
		[[DOWN, DOWN, ENTER, ..."other", ENTER], "User wrote: other", { answer: "other", wasCustom: true }],
		[[ESC], "User cancelled the selection", { answer: null }],
	];
	for (const [keys, text, details] of cases) {
		const r = await t.execute("t", params, undefined, undefined, toolCtx(keys));
		assert.equal(r.content[0].text, text);
		assert.deepEqual(r.details, { question: "Push?", options: ["Merge only (Recommended)", "Push"], ...details });
	}
	// A router answering instead of the dialog (pi-memo-subagents ask-parent) still works for the tool.
	const routed = await t.execute("t", params, undefined, undefined, {
		hasUI: true,
		ui: { custom: async () => ({ answer: "Push", custom: false, index: 2, note: "from parent" }) },
	});
	assert.equal(routed.content[0].text, "User selected: 2. Push\nUser note: from parent");
	// RPC (custom returns undefined): the select fallback answers the tool.
	const rpc = await t.execute("t", params, undefined, undefined, {
		hasUI: true,
		mode: "rpc",
		ui: { custom: async () => undefined, select: async (_: string, o: string[]) => o[1] },
	});
	assert.equal(rpc.content[0].text, "User selected: 2. Push");
});
