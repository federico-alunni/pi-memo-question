/**
 * `question` tool: one question to the user with options (recommended first), optional per-option note
 * (Tab) and free answer. The only question tool: loaded by the main agent (settings package or `-e`) and
 * by every pi-memo-subagents child that may ask (the runtime adds it with `-e`).
 * A router (src/router.ts) may answer for the parent agent; otherwise the user answers in `ask()` (src/ask.ts)
 * with one question, free answer and notes on: while the dialog is open it emits `memo-question` and
 * `herdr:blocked` (see src/events.ts).
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { ask, askComponent } from "../src/ask.ts";
import { answerText, FREE_ANSWER, questionAnswer, questionComponent } from "../src/dialog.ts";
import type { QuestionAnswer, QuestionOption } from "../src/dialog.ts";
import { currentRouter, QUESTION_DIALOG_KEY } from "../src/router.ts";
import type { QuestionDialogApi, QuestionTarget } from "../src/router.ts";

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
	note?: string;
	/** Set when someone other than the user answered (e.g. "the parent agent"). */
	answeredBy?: string;
}

/** The result text when `by` (not the user) answered. */
export function answeredText(answer: QuestionAnswer | null, by: string, note?: string): string {
	const who = by.charAt(0).toUpperCase() + by.slice(1);
	let text = !answer
		? `${who} did not choose an option`
		: answer.custom
			? `${who} wrote: ${answer.answer}`
			: `${who} selected: ${answer.index}. ${answer.answer}${answer.note ? `\n${who} note: ${answer.note}` : ""}`;
	if (note?.trim() && !(answer && !answer.custom && answer.note)) text += `\nNote: ${note.trim()}`;
	return text;
}

const QuestionParams = Type.Object({
	question: Type.String({ description: "The question to ask the user" }),
	options: Type.Array(
		Type.Object({
			label: Type.String({ description: "Display label for the option" }),
			description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
		}),
		{ description: "Options for the user to choose from" },
	),
	to: Type.Optional(
		Type.Union([Type.Literal("user"), Type.Literal("parent")], {
			description:
				'Who should answer. "parent": the agent that started you, when it can know the answer (decisions and context of its session or plan); it may forward the question to the user. "user": the human, for what only they can decide or know. Omitted: the default of this session (the user unless you run as a subagent). Without a parent agent the user is asked.',
		}),
	),
});

export default function question(pi: ExtensionAPI) {
	(globalThis as Record<symbol, unknown>)[QUESTION_DIALOG_KEY] = { questionComponent, ask, askComponent } satisfies QuestionDialogApi;
	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask a question and let the user (or, with to: \"parent\", the agent that started you) pick from options. Use when you need input to proceed. Every question MUST always have a recommended option as the first choice, explicitly labeled with '(Recommended)'. Add a short description per option when useful. The user may also type a free answer or attach a note to an option.",
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = params.options.map((o) => o.label);
			const router = currentRouter();
			const target: QuestionTarget = params.to ?? router?.defaultTarget() ?? "user";
			const details = (answer: string | null, extra: Partial<QuestionDetails> = {}): QuestionDetails => ({
				question: params.question,
				options,
				answer,
				...extra,
			});
			if (params.options.length === 0)
				return { content: [{ type: "text", text: "Error: No options provided" }], details: details(null) };

			const id = randomUUID();
			// The parent first (when there is one and the call is for it); the user's dialog otherwise or as fallback.
			let fallback: string | undefined;
			if (target === "parent" && !router) fallback = "no parent agent to ask: the user answered";
			if (target === "parent" && router) {
				let outcome;
				try {
					outcome = await router.askParent(
						{ id, question: params.question, options: params.options as QuestionOption[] },
						signal,
					);
				} catch (error) {
					outcome = { kind: "user" as const, reason: error instanceof Error ? error.message : String(error) };
				}
				if (outcome.kind === "answered")
					return {
						content: [{ type: "text", text: answeredText(outcome.answer, outcome.by, outcome.note) }],
						details: {
							...details(outcome.answer?.answer ?? null, {
								answeredBy: outcome.by,
								...(outcome.answer ? { wasCustom: outcome.answer.custom } : {}),
								...(outcome.answer && !outcome.answer.custom && outcome.answer.note ? { note: outcome.answer.note } : {}),
							}),
							...(outcome.details ?? {}),
						},
					};
				if (outcome.kind === "cancelled" || signal?.aborted)
					return {
						content: [{ type: "text", text: "The question was withdrawn: the turn was aborted" }],
						details: details(null),
					};
				fallback = outcome.reason ? `the parent agent could not answer (${outcome.reason}): the user answered` : "the parent agent could not answer: the user answered";
			}
			if (!ctx.hasUI)
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: details(null),
				};

			// The user's dialog is ask() with one question, free answer and notes on (same events, same id as the
			// router's question). An aborted turn closes it: for the model it is a cancellation, as before.
			const result = questionAnswer(
				await ask(
					ctx,
					{ title: params.question, questions: [{ id: "question", title: params.question, options: params.options as QuestionOption[] }] },
					{ signal, pi, id },
				),
			);

			return {
				content: [{ type: "text", text: fallback ? `${answerText(result)}\n(${fallback})` : answerText(result) }],
				details: !result
					? details(null)
					: result.custom
						? details(result.answer, { wasCustom: true })
						: details(result.answer, { wasCustom: false, ...(result.note ? { note: result.note } : {}) }),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const numbered = [...opts.map((o: QuestionOption) => o.label), FREE_ANSWER].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  Options: ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.answer === null) return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			if (details.wasCustom)
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			const noteSuffix = details.note ? theme.fg("muted", ` (note: ${details.note})`) : "";
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display) + noteSuffix, 0, 0);
		},
	});
}
