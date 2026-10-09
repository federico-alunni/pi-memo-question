/**
 * `question` tool: one or more questions to the user, each with options (recommended first), single or
 * multiple choice, optional per-option note (Tab, single choice) and free answer. The only question tool:
 * loaded by the main agent (settings package or `-e`) and by every pi-memo-subagents child that may ask (the
 * runtime adds it with `-e`). Several questions are asked one after the other and answered in one result.
 * While a dialog is open it emits `memo-question` and `herdr:blocked` (see src/events.ts).
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { answerText, describeSelection, FREE_ANSWER, questionComponent, questionnaireComponent } from "../src/dialog.ts";
import type { QuestionAnswer, QuestionOption } from "../src/dialog.ts";
import { QUESTION_EVENT } from "../src/events.ts";
import type { QuestionEvent } from "../src/events.ts";
import { currentRouter, QUESTION_DIALOG_KEY } from "../src/router.ts";
import type { QuestionDialogApi, QuestionTarget } from "../src/router.ts";

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
	note?: string;
	/** Several options chosen (multiple choice). */
	multi?: { indexes: number[]; labels: string[]; other?: string };
	/** Set when someone other than the user answered (e.g. "the parent agent"). */
	answeredBy?: string;
	/** With several questions: the details of each question asked, in order. */
	results?: QuestionDetails[];
}

/** The result text when `by` (not the user) answered. */
export function answeredText(answer: QuestionAnswer | null, by: string, note?: string): string {
	const who = by.charAt(0).toUpperCase() + by.slice(1);
	let text = !answer
		? `${who} did not choose an option`
		: answer.custom
			? `${who} wrote: ${answer.answer}`
			: "multi" in answer
				? `${who} selected: ${describeSelection(answer)}${answer.other ? `\n${who} also wrote: ${answer.other}` : ""}`
				: `${who} selected: ${describeSelection(answer)}${answer.note ? `\n${who} note: ${answer.note}` : ""}`;
	if (note?.trim() && !(answer && !answer.custom && "note" in answer && answer.note)) text += `\nNote: ${note.trim()}`;
	return text;
}

const MAX_QUESTIONS = 9;

// `questions` is the list shape other question tools use (AskUserQuestion, opencode `question`): viewers
// that read the session log, such as Collie, recognise it and draw each question with its options.
const QuestionItem = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	header: Type.Optional(
		Type.String({ description: "Very short label (max ~14 characters) of the question's tab when there are several, e.g. \"Base\"" }),
	),
	options: Type.Array(
		Type.Object({
			label: Type.String({ description: "Display label for the option" }),
			description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
		}),
		{ description: "Options for the user to choose from" },
	),
	multiple: Type.Optional(
		Type.Boolean({ description: "true: the user may pick several options (default: exactly one)" }),
	),
});

const QuestionParams = Type.Object({
	questions: Type.Array(QuestionItem, {
		minItems: 1,
		maxItems: MAX_QUESTIONS,
		description: "One or more questions, asked one after the other",
	}),
	to: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("parent")], {
			description:
				'Who should answer. "parent": the agent that started you, when it can know the answer (decisions and context of its session or plan); it may forward the question to the user. "user": the human, for what only they can decide or know. Omitted: the default of this session (the user unless you run as a subagent). Without a parent agent the user is asked.',
		}),
	),
});

interface OneQuestion {
	question: string;
	options: QuestionOption[];
	multiple: boolean;
	header?: string;
}

const readQuestion = (q: any): OneQuestion => ({
	question: typeof q?.question === "string" ? q.question : "",
	options: Array.isArray(q?.options) ? (q.options as QuestionOption[]) : [],
	multiple: q?.multiple === true,
	...(typeof q?.header === "string" && q.header.trim() ? { header: q.header.trim() } : {}),
});

/** The questions a call carries: `questions`, or the pre-0.3 top-level `question`/`options` (one question). */
export function questionsOf(args: any): OneQuestion[] {
	if (Array.isArray(args?.questions)) return args.questions.map(readQuestion);
	return typeof args?.question === "string" ? [readQuestion(args)] : [];
}

const detailsOf = (q: OneQuestion, answer: string | null, extra: Partial<QuestionDetails> = {}): QuestionDetails => ({
	question: q.question,
	options: q.options.map((o) => o.label),
	answer,
	...extra,
});

interface Asked {
	text: string;
	details: QuestionDetails;
	/** The question ended the call: cancelled, withdrawn or no way to ask. The next ones are not asked. */
	stop: boolean;
}

/** What the user's answer (null = cancelled) to `q` returns to the model. `fallback` says why the user was asked. */
function settled(q: OneQuestion, result: QuestionAnswer | null, fallback?: string): Asked {
	const details = (answer: string | null, extra: Partial<QuestionDetails> = {}) => detailsOf(q, answer, extra);
	return {
		text: fallback ? `${answerText(result)}\n(${fallback})` : answerText(result),
		details: !result
			? details(null)
			: result.custom
				? details(result.answer, { wasCustom: true })
				: "multi" in result
					? details(result.answer, {
							wasCustom: false,
							multi: {
								indexes: result.indexes,
								labels: result.labels,
								...(result.other ? { other: result.other } : {}),
							},
						})
					: details(result.answer, { wasCustom: false, ...(result.note ? { note: result.note } : {}) }),
		stop: !result,
	};
}

export default function question(pi: ExtensionAPI) {
	(globalThis as Record<symbol, unknown>)[QUESTION_DIALOG_KEY] = { questionComponent, questionnaireComponent } satisfies QuestionDialogApi;
	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user one or more questions and let them pick from options (or, with to: \"parent\", ask the agent that started you). Use when you need input to proceed. Put several questions in `questions` when you need more than one answer: they are asked one after the other and the answers come back together. Set `multiple: true` on a question when several options may apply. Every question MUST always have a recommended option as the first choice, explicitly labeled with '(Recommended)'. Add a short description per option when useful. The user may also type a free answer or, on a single-choice question, attach a note to an option.",
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
			const questions = questionsOf(rawParams);
			const router = currentRouter();
			const target: QuestionTarget = rawParams.to ?? router?.defaultTarget() ?? "user";
			if (questions.length === 0)
				return {
					content: [{ type: "text", text: "Error: No question provided" }],
					details: detailsOf({ question: "", options: [], multiple: false }, null),
				};
			const empty = questions.find((q) => q.options.length === 0);
			if (empty)
				return { content: [{ type: "text", text: "Error: No options provided" }], details: detailsOf(empty, null) };

			const ask = async (q: OneQuestion): Promise<Asked> => {
				const details = (answer: string | null, extra: Partial<QuestionDetails> = {}) => detailsOf(q, answer, extra);
				const id = randomUUID();
				// The parent first (when there is one and the call is for it); the user's dialog otherwise or as fallback.
				let fallback: string | undefined;
				if (target === "parent" && !router) fallback = "no parent agent to ask: the user answered";
				if (target === "parent" && router) {
					let outcome;
					try {
						outcome = await router.askParent(
							{ id, question: q.question, options: q.options, ...(q.multiple ? { multiple: true } : {}) },
							signal,
						);
					} catch (error) {
						outcome = { kind: "user" as const, reason: error instanceof Error ? error.message : String(error) };
					}
					if (outcome.kind === "answered")
						return {
							text: answeredText(outcome.answer, outcome.by, outcome.note),
							details: {
								...details(outcome.answer?.answer ?? null, {
									answeredBy: outcome.by,
									...(outcome.answer ? { wasCustom: outcome.answer.custom } : {}),
									...(outcome.answer && !outcome.answer.custom && "note" in outcome.answer && outcome.answer.note
										? { note: outcome.answer.note }
										: {}),
								}),
								...(outcome.details ?? {}),
							},
							stop: !outcome.answer,
						};
					if (outcome.kind === "cancelled" || signal?.aborted)
						return { text: "The question was withdrawn: the turn was aborted", details: details(null), stop: true };
					fallback = outcome.reason
						? `the parent agent could not answer (${outcome.reason}): the user answered`
						: "the parent agent could not answer: the user answered";
				}
				if (!ctx.hasUI)
					return {
						text: "Error: UI not available (running in non-interactive mode)",
						details: details(null),
						stop: true,
					};

				const emit = (event: QuestionEvent) => pi.events.emit(QUESTION_EVENT, event);
				emit({ id, question: q.question, pending: true });
				pi.events.emit("herdr:blocked", { active: true, label: q.question });
				let result: QuestionAnswer | null = null;
				try {
					if (!signal?.aborted)
						result = await ctx.ui.custom<QuestionAnswer | null>((tui, theme, _kb, done) => {
							let settled = false;
							const finish = (r: QuestionAnswer | null) => {
								if (!settled) {
									settled = true;
									done(r);
								}
							};
							// The dialog has no abort option: an aborted turn closes it as cancelled.
							signal?.addEventListener("abort", () => finish(null), { once: true });
							return questionComponent(tui, theme, q.question, q.options, finish, { multiple: q.multiple });
						});
				} finally {
					pi.events.emit("herdr:blocked", { active: false });
					emit({ id, question: q.question, pending: false, answer: result?.answer ?? null });
				}

				return settled(q, result, fallback);
			};

			// Several questions for the user: one dialog with a tab per question and a final review. Questions that go
			// through a parent agent (or fall back from it) are asked one at a time instead.
			const questionnaire = questions.length > 1 && target === "user";
			let asked: { q: OneQuestion; r: Asked }[] = [];
			if (questionnaire) {
				if (!ctx.hasUI)
					return {
						content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
						details: detailsOf({ question: `${questions.length} questions`, options: [], multiple: false }, null),
					};
				const id = randomUUID();
				const label = `${questions[0].question} (+${questions.length - 1} more)`;
				const emit = (event: QuestionEvent) => pi.events.emit(QUESTION_EVENT, event);
				emit({ id, question: label, pending: true });
				pi.events.emit("herdr:blocked", { active: true, label });
				let answers: QuestionAnswer[] | null = null;
				try {
					if (!signal?.aborted)
						answers = await ctx.ui.custom<QuestionAnswer[] | null>((tui, theme, _kb, done) => {
							let closed = false;
							const finish = (r: QuestionAnswer[] | null) => {
								if (!closed) {
									closed = true;
									done(r);
								}
							};
							signal?.addEventListener("abort", () => finish(null), { once: true });
							return questionnaireComponent(tui, theme, questions, finish);
						});
				} finally {
					pi.events.emit("herdr:blocked", { active: false });
					emit({ id, question: label, pending: false, answer: answers ? answers.map((a) => a.answer).join(" | ") : null });
				}
				// Cancelling the questionnaire cancels every question.
				if (!answers)
					return {
						content: [{ type: "text", text: answerText(null) }],
						details: detailsOf({ question: `${questions.length} questions`, options: [], multiple: false }, null),
					};
				asked = questions.map((q, i) => ({ q, r: settled(q, answers![i]) }));
			} else {
				for (const q of questions) {
					const r = await ask(q);
					asked.push({ q, r });
					if (r.stop) break;
				}
			}
			// One question: the result is exactly the single-question one.
			if (questions.length === 1)
				return { content: [{ type: "text", text: asked[0].r.text }], details: asked[0].r.details };

			const total = questions.length;
			const skipped = total - asked.length;
			const text =
				asked.map(({ q, r }, i) => `[${i + 1}/${total}] ${q.question}\n${r.text}`).join("\n\n") +
				(skipped ? `\n\n(${skipped} more question${skipped > 1 ? "s" : ""} not asked)` : "");
			return {
				content: [{ type: "text", text }],
				details: {
					question: `${total} questions`,
					options: [],
					answer: skipped || asked.some(({ r }) => r.details.answer === null) ? null : asked.map(({ r }) => r.details.answer).join(" | "),
					results: asked.map(({ r }) => r.details),
				} satisfies QuestionDetails,
			};
		},

		renderCall(args, theme) {
			const qs = questionsOf(args);
			const one = (q: OneQuestion, lead: string) => {
				let text = lead + theme.fg("muted", q.question);
				if (q.options.length) {
					const numbered = [...q.options.map((o) => o.label), FREE_ANSWER].map((o, i) => `${i + 1}. ${o}`);
					text += `\n${theme.fg("dim", `  Options${q.multiple ? " (several allowed)" : ""}: ${numbered.join(", ")}`)}`;
				}
				return text;
			};
			const title = theme.fg("toolTitle", theme.bold("question "));
			if (qs.length <= 1) return new Text(title + one(qs[0] ?? { question: "", options: [], multiple: false }, ""), 0, 0);
			const list = qs.map((q, i) => `\n${one(q, theme.fg("dim", `[${i + 1}/${qs.length}] `))}`).join("");
			return new Text(title + theme.fg("muted", `${qs.length} questions`) + list, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			const line = (d: QuestionDetails): string => {
				if (d.answer === null) return theme.fg("warning", "Cancelled");
				if (d.wasCustom)
					return theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", d.answer);
				if (d.multi) {
					const shown = d.multi.indexes.map((n, k) => `${n}. ${d.multi!.labels[k]}`).join(", ");
					const other = d.multi.other ? theme.fg("muted", ` (also wrote: ${d.multi.other})`) : "";
					return theme.fg("success", "✓ ") + theme.fg("accent", shown) + other;
				}
				const idx = d.options.indexOf(d.answer) + 1;
				const display = idx > 0 ? `${idx}. ${d.answer}` : d.answer;
				const noteSuffix = d.note ? theme.fg("muted", ` (note: ${d.note})`) : "";
				return theme.fg("success", "✓ ") + theme.fg("accent", display) + noteSuffix;
			};
			if (details.results)
				return new Text(
					details.results
						.map((d, i) => `${theme.fg("dim", `[${i + 1}/${details.results!.length}] `)}${theme.fg("muted", d.question)}\n  ${line(d)}`)
						.join("\n"),
					0,
					0,
				);
			return new Text(line(details), 0, 0);
		},
	});
}
