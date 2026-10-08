/**
 * `question` tool: one question to the user with options (recommended first), optional per-option note
 * (Tab) and free answer. The only question tool: loaded by the main agent (settings package or `-e`) and
 * by every pi-memo-subagents child that may ask (the runtime adds it with `-e`).
 * While the dialog is open it emits `memo-question` and `herdr:blocked` (see src/events.ts).
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { answerText, FREE_ANSWER, questionComponent } from "../src/dialog.ts";
import type { QuestionAnswer, QuestionOption } from "../src/dialog.ts";
import { QUESTION_EVENT } from "../src/events.ts";
import type { QuestionEvent } from "../src/events.ts";

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
	note?: string;
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
});

export default function question(pi: ExtensionAPI) {
	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Ask the user a question and let them pick from options. Use when you need user input to proceed. Every question MUST always have a recommended option as the first choice, explicitly labeled with '(Recommended)'. Add a short description per option when useful. The user may also type a free answer or attach a note to an option.",
		parameters: QuestionParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const options = params.options.map((o) => o.label);
			const details = (answer: string | null, extra: Partial<QuestionDetails> = {}): QuestionDetails => ({
				question: params.question,
				options,
				answer,
				...extra,
			});
			if (!ctx.hasUI)
				return {
					content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }],
					details: details(null),
				};
			if (params.options.length === 0)
				return { content: [{ type: "text", text: "Error: No options provided" }], details: details(null) };

			const id = randomUUID();
			const emit = (event: QuestionEvent) => pi.events.emit(QUESTION_EVENT, event);
			emit({ id, question: params.question, pending: true });
			pi.events.emit("herdr:blocked", { active: true, label: params.question });
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
						return questionComponent(tui, theme, params.question, params.options as QuestionOption[], finish);
					});
			} finally {
				pi.events.emit("herdr:blocked", { active: false });
				emit({ id, question: params.question, pending: false, answer: result?.answer ?? null });
			}

			return {
				content: [{ type: "text", text: answerText(result) }],
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
