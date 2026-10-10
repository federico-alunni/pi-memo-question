import test from "node:test";
import assert from "node:assert/strict";
import { FREE_ANSWER, answerText, matchOption, matchOptions, questionComponent, questionnaireComponent } from "../src/dialog.ts";
import type { QuestionAnswer } from "../src/dialog.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const ENTER = "\r";
const ESC = "\x1b";
const theme = { fg: (_c: string, t: string) => t };
const tui: any = { requestRender() {}, terminal: { rows: 40, columns: 80 } };
const options = [{ label: "Merge (Recommended)", description: "starts from 739e432" }, { label: "Only 739e432" }];

function open() {
	const results: (QuestionAnswer | null)[] = [];
	const c = questionComponent(tui, theme, "Which base?", options, (r) => results.push(r));
	const type = (...keys: string[]) => keys.forEach((k) => c.handleInput(k));
	return { c, results, type };
}

test("descriptions below options, free answer last, Tab hint", () => {
	const lines = open().c.render(80).join("\n");
	assert.match(lines, /> 1\. Merge \(Recommended\)\n {5}starts from 739e432\n {2}2\. Only 739e432\n {2}3\. Type something\./);
	assert.match(lines, /Tab to add note/);
	assert.equal(FREE_ANSWER, "Type something.");
});

test("arrows + Enter select, Tab attaches a note", () => {
	let d = open();
	d.type(DOWN, ENTER);
	assert.deepEqual(d.results, [{ answer: "Only 739e432", custom: false, index: 2 }]);

	d = open();
	d.type(TAB, ..."docs only", ENTER);
	assert.deepEqual(d.results, [{ answer: "Merge (Recommended)", custom: false, index: 1, note: "docs only" }]);
	assert.equal(answerText(d.results[0]), "User selected: 1. Merge (Recommended)\nUser note: docs only");
});

test("typed answers: a number or a label picks the option, other text is a free answer", () => {
	// Collie on a pi pane: raw text in one chunk, then Enter.
	let d = open();
	d.type("2", ENTER);
	assert.deepEqual(d.results, [{ answer: "Only 739e432", custom: false, index: 2 }]);

	// The same text one key at a time, as a terminal types it.
	d = open();
	d.type(..."merge", ENTER);
	assert.deepEqual(d.results, [{ answer: "Merge (Recommended)", custom: false, index: 1 }]);

	d = open();
	d.type("2 but rebase first", ENTER);
	assert.deepEqual(d.results, [{ answer: "2 but rebase first", custom: true }]);

	// The free-answer row's own number is not an option.
	d = open();
	d.type("3", ENTER);
	assert.deepEqual(d.results, [{ answer: "3", custom: true }]);

	// Kitty keyboard protocol: CSI u for "1".
	d = open();
	d.type("\x1b[49u", ENTER);
	assert.deepEqual(d.results, [{ answer: "Merge (Recommended)", custom: false, index: 1 }]);

	// Typing opens the answer field; Esc returns to the list without answering; spaces alone do nothing.
	d = open();
	d.type("x");
	assert.match(d.c.render(80).join("\n"), /Your answer/);
	d.type(ESC, " ", DOWN, ENTER);
	assert.deepEqual(d.results, [{ answer: "Only 739e432", custom: false, index: 2 }]);

	assert.equal(matchOption(options, " ONLY 739E432 "), 1);
	assert.equal(matchOption(options, "0"), undefined);
});

const SPACE = " ";
const checks = [{ label: "Lint (Recommended)", description: "eslint" }, { label: "Tests" }, { label: "Types, strict" }];

function openMulti() {
	const results: (QuestionAnswer | null)[] = [];
	const c = questionComponent(tui, theme, "Which checks?", checks, (r) => results.push(r), { multiple: true });
	const type = (...keys: string[]) => keys.forEach((k) => c.handleInput(k));
	return { c, results, type };
}

test("multiple choice: Space ticks, Enter confirms the ticked ones", () => {
	let d = openMulti();
	const screen = d.c.render(80).join("\n");
	assert.match(screen, /Pick one or more options\./);
	assert.match(screen, /> \[ \] 1\. Lint \(Recommended\)\n {9}eslint\n {2}\[ \] 2\. Tests\n {2}\[ \] 3\. Types, strict\n {6}4\. Type something\./);
	assert.match(screen, /Space to tick/);
	d.type(SPACE, DOWN, DOWN, SPACE);
	assert.match(d.c.render(80).join("\n"), /\[x\] 1\. Lint[\s\S]*> \[x\] 3\. Types/);
	d.type(ENTER);
	assert.deepEqual(d.results, [
		{ answer: "Lint (Recommended), Types, strict", custom: false, multi: true, indexes: [1, 3], labels: ["Lint (Recommended)", "Types, strict"] },
	]);
	assert.equal(answerText(d.results[0]), "User selected: 1. Lint (Recommended), 3. Types, strict");

	// Space again unticks; with nothing ticked Enter confirms the pointed option.
	d = openMulti();
	d.type(SPACE, SPACE, DOWN, ENTER);
	assert.deepEqual(d.results.map((r: any) => r.indexes), [[2]]);

	// Space and Tab do nothing on the free-answer row / in multiple choice (no notes).
	d = openMulti();
	d.type(DOWN, DOWN, DOWN, SPACE, TAB);
	assert.doesNotMatch(d.c.render(80).join("\n"), /note \/ comment|\[x\]/);
	d.type(ESC);
	assert.deepEqual(d.results, [null]);
});

test("multiple choice: typed answers name several options, free text goes next to the ticked ones", () => {
	let d = openMulti();
	d.type("1,3", ENTER); // Collie: raw text in one chunk, then Enter
	assert.deepEqual(d.results.map((r: any) => r.indexes), [[1, 3]]);

	d = openMulti();
	d.type(..."1 2", ENTER);
	assert.deepEqual(d.results.map((r: any) => r.indexes), [[1, 2]]);

	d = openMulti();
	d.type(SPACE, "3", ENTER); // ticked + typed are merged
	assert.deepEqual(d.results.map((r: any) => r.indexes), [[1, 3]]);

	d = openMulti();
	d.type(SPACE, "also docs", ENTER); // ticked + free text
	assert.deepEqual(d.results, [
		{ answer: "Lint (Recommended), also docs", custom: false, multi: true, indexes: [1], labels: ["Lint (Recommended)"], other: "also docs" },
	]);
	assert.equal(answerText(d.results[0]), "User selected: 1. Lint (Recommended)\nUser also wrote: also docs");

	// The recorded multi answer shows a check on its ticked options and on the free answer row.
	const recorded = questionComponent(tui, theme, "Which checks?", checks, () => {}, {
		multiple: true,
		answered: () => ({ answer: "Lint (Recommended), superman", custom: false, multi: true, indexes: [1], labels: ["Lint (Recommended)"], other: "superman" }),
	});
	const rec = recorded.render(80).join("\n");
	assert.match(rec, /1\. Lint \(Recommended\)[^\n]*✓/);
	assert.match(rec, /Type something\.[^\n]*✓/);
	assert.doesNotMatch(rec, /2\. Tests[^\n]*✓/);

	d = openMulti();
	d.type("nothing fits", ENTER); // nothing ticked: a plain free answer
	assert.deepEqual(d.results, [{ answer: "nothing fits", custom: true }]);

	assert.deepEqual(matchOptions(checks, "1-2"), [0, 1]);
	assert.deepEqual(matchOptions(checks, "Types, strict"), [2]); // a label with a comma
	assert.deepEqual(matchOptions(checks, "tests; lint"), [0, 1]);
	assert.equal(matchOptions(checks, "1, 9"), undefined);
	assert.equal(matchOptions(checks, "2-9"), undefined);
});

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const SHIFT_TAB = "\x1b[Z";
const items = [
	{ header: "Base", question: "Which base?", options },
	{ header: "Checks", question: "Which checks?", multiple: true, options: checks },
	{ question: "README too?", options: [{ label: "Yes (Recommended)" }, { label: "No" }] },
];

function openQuestionnaire(width = 80) {
	let outcome: any = "pending";
	const c = questionnaireComponent(tui, theme, items, (r) => (outcome = r));
	const type = (...keys: string[]) => keys.forEach((k) => c.handleInput(k));
	const screen = () => c.render(width).join("\n");
	return { c, type, screen, outcome: () => outcome };
}

test("questionnaire: a tab per question and a Review tab, answering moves to the next open one", () => {
	const d = openQuestionnaire();
	assert.match(d.screen(), /\u2190 +\u25a2 +Base +\u25a2 +Checks +\u25a2 +Q3 +\u2713 Review +\u2192/);
	assert.match(d.screen(), /Which base\?[\s\S]*> 1\. Merge/);
	assert.match(d.screen(), /\u2190\u2192 tabs/);
	d.type(ENTER); // answers Q1, lands on Q2
	assert.match(d.screen(), /\u25a3 +Base +\u25a2 +Checks/);
	assert.match(d.screen(), /Which checks\?[\s\S]*Pick one or more/);
	d.type(SPACE, DOWN, DOWN, SPACE, ENTER, "2", ENTER); // ticks 1 and 3, then Q3 typed "2" + Enter
	assert.match(d.screen(), /Review your answers/);
	assert.match(d.screen(), / 1\. Base +Merge \(Recommended\)\n 2\. Checks +Lint \(Recommended\), Types, strict\n 3\. Q3 +No\n/);
	assert.match(d.screen(), /All answered/);
	assert.equal(d.outcome(), "pending");
	d.type("ok", ENTER); // a viewer that only types text: any text, then Enter
	assert.deepEqual(d.outcome().map((a: any) => a.answer), ["Merge (Recommended)", "Lint (Recommended), Types, strict", "No"]);
});

test("questionnaire: tabs move with arrows and Tab, answered tabs keep their marks, ticks and answers", () => {
	const d = openQuestionnaire();
	d.type(DOWN, ENTER, SPACE, ENTER); // Q1 = 2, Q2 = [1]
	d.type(LEFT);
	assert.match(d.screen(), /Which checks\?[\s\S]*\[x\] 1\. Lint/);
	d.type(SHIFT_TAB);
	assert.match(d.screen(), /Which base\?/);
	assert.match(d.screen(), /> 2\. Only 739e432 \u2713/); // the recorded answer is marked
	d.type(RIGHT, TAB, TAB); // Q2, Q3, Review
	assert.match(d.screen(), /Review your answers/);
	d.type(RIGHT); // wraps around to the first tab
	assert.match(d.screen(), /Which base\?/);
	d.type(LEFT); // and back to Review
	assert.match(d.screen(), /Review your answers/);
});

test("questionnaire: Enter on an incomplete Review goes to the first open question; Esc cancels everything", () => {
	let d = openQuestionnaire();
	d.type(ENTER, ENTER); // Q1 and Q2 answered, the questionnaire is now on Q3
	d.type(RIGHT); // Review
	assert.match(d.screen(), /Review your answers/);
	assert.match(d.screen(), /3\. Q3 +\u2014 not answered/);
	assert.match(d.screen(), /Unanswered: Q3/);
	assert.match(d.screen(), /Enter goes to the first unanswered/);
	d.type(ENTER);
	assert.match(d.screen(), /README too\?/);
	assert.equal(d.outcome(), "pending");
	d.type(ESC);
	assert.equal(d.outcome(), null);

	d = openQuestionnaire();
	d.type(RIGHT, RIGHT, RIGHT, ESC); // Esc on Review too
	assert.equal(d.outcome(), null);
});

test("questionnaire: typed answers per tab, arrows edit the text and do not change tab while typing", () => {
	const d = openQuestionnaire();
	d.type("x", LEFT, "y"); // typing opens the answer field: arrows belong to the editor
	assert.match(d.screen(), /Your answer/);
	assert.match(d.screen(), /Which base\?/);
	d.type(ESC); // Esc goes back to the list, not out of the questionnaire
	assert.equal(d.outcome(), "pending");
	d.type("2", ENTER); // Q1 = option 2
	assert.match(d.screen(), /Which checks\?/);
	d.type("1,3", ENTER, "something else", ENTER);
	assert.match(d.screen(), /3\. Q3 +\(wrote\) something else/);
	d.type(ENTER);
	assert.deepEqual(d.outcome().map((a: any) => a.answer), ["Only 739e432", "Lint (Recommended), Types, strict", "something else"]);
});

test("questionnaire: the tab bar shrinks to numbers on a narrow screen", () => {
	const d = openQuestionnaire(40);
	const bar = d.screen().split("\n")[1];
	assert.match(bar, /\u2190 +\u25a2 +1 +\u25a2 +2 +\u25a2 +3 +\u2713 +\u2192/);
	assert.ok(d.screen().split("\n").every((l) => l.length <= 40));
});

test("free answer inline, Esc goes back then cancels", () => {
	let d = open();
	d.type(DOWN, DOWN, TAB); // Tab on the free answer does nothing
	assert.doesNotMatch(d.c.render(80).join("\n"), /note \/ comment/);
	d.type(ENTER, ..."another plan", ENTER);
	assert.deepEqual(d.results, [{ answer: "another plan", custom: true }]);
	assert.equal(answerText(d.results[0]), "User wrote: another plan");

	d = open();
	d.type(TAB, ESC); // leaves the note editor without answering
	assert.deepEqual(d.results, []);
	d.type(UP, ESC);
	assert.deepEqual(d.results, [null]);
	assert.equal(answerText(null), "User cancelled the selection");
});
