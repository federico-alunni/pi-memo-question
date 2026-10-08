import test from "node:test";
import assert from "node:assert/strict";
import { FREE_ANSWER, answerText, questionComponent } from "../src/dialog.ts";
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
