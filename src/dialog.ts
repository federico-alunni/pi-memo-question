// The single-question dialog of the `question` tool, kept for its users (pi-memo-subagents' escalation
// dialog): options with descriptions, Tab adds a note to an option, inline free answer, Esc cancels.
// It is the ask dialog (src/ask-dialog.ts) with one question, free answer and notes on.
import type { TUI } from "@earendil-works/pi-tui";
import { askComponent, FREE_ANSWER } from "./ask-dialog.ts";
import type { AskResult, DialogTheme } from "./ask-dialog.ts";

export { FREE_ANSWER };

export interface QuestionOption {
	label: string;
	description?: string;
}

/** Chosen option (1-based index, optional note) or a free answer; null = cancelled. */
export type QuestionAnswer =
	| { answer: string; custom: false; index: number; note?: string }
	| { answer: string; custom: true };

const ID = "question";

/** The `question` tool's answer for an ask result of its one question (null = cancelled or aborted). */
export function questionAnswer(result: AskResult, id = ID): QuestionAnswer | null {
	if (result.status !== "answered") return null;
	const a = result.answers[id];
	if (!a) return null;
	if (a.custom !== undefined) return { answer: a.custom, custom: true };
	if (!a.labels.length) return null;
	return {
		answer: a.labels[0],
		custom: false,
		index: (a.indices[0] ?? -1) + 1,
		...(a.note ? { note: a.note } : {}),
	};
}

export function questionComponent(
	tui: TUI,
	theme: DialogTheme,
	question: string,
	options: QuestionOption[],
	done: (result: QuestionAnswer | null) => void,
) {
	return askComponent(tui, theme, { questions: [{ id: ID, title: question, options }] }, (r) => done(questionAnswer(r)));
}

/** Text returned to the model for an answer (null = cancelled). */
export function answerText(result: QuestionAnswer | null): string {
	if (!result) return "User cancelled the selection";
	if (result.custom) return `User wrote: ${result.answer}`;
	return `User selected: ${result.index}. ${result.answer}${result.note ? `\nUser note: ${result.note}` : ""}`;
}
