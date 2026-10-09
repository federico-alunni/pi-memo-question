/**
 * `ask()`: the question dialog called from extension code. The user answers, never the model: the result
 * is structured data for the caller, not text for the model. Same look and same events as the `question`
 * tool's dialogs (src/dialog.ts); never routed to a parent agent (the router is the tool's only).
 *
 * Events on `opts.pi.events` (without `pi`, none): `memo-question` pending/settled with one unique id, and
 * `herdr:blocked` around the dialog (see src/events.ts).
 *
 * Without custom UI (RPC: `ctx.ui.custom` returns undefined; missing or throwing `custom`) it falls back to
 * one `ctx.ui.select` per question; without any UI it returns `cancelled` with a reason. It never throws.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askComponent, FREE_ANSWER, isDialogResult } from "./ask-dialog.ts";
import type { Answers, AskOption, AskRequest, AskResult, Question, QuestionResult, ReviewSpec } from "./ask-dialog.ts";
import { QUESTION_EVENT } from "./events.ts";
import type { QuestionEvent } from "./events.ts";

export { askComponent, DEFAULT_GUARD_MS, FREE_ANSWER, guardMsOf, isDialogResult } from "./ask-dialog.ts";
export type {
	Answers,
	AskComponent,
	AskOption,
	AskRequest,
	AskResult,
	DialogTheme,
	Question,
	QuestionResult,
	ReviewResult,
	ReviewSpec,
} from "./ask-dialog.ts";

/**
 * Set on the factory passed to `ctx.ui.custom`: the request's audience ("user" | "any"). A router that
 * replaces `ctx.ui.custom` (pi-memo-subagents' ask-parent) can read it to never route "user" dialogs; this
 * package does not depend on it: with audience "user" an answer not produced by the dialog is refused.
 */
export const ASK_AUDIENCE: unique symbol = Symbol.for("pi-memo-question.audience") as any;

export interface AskOptions {
	signal?: AbortSignal;
	/** For the `memo-question` and `herdr:blocked` events. */
	pi?: Pick<ExtensionAPI, "events">;
	/** Id of the `memo-question` events (default: a new UUID), e.g. to match a router's question. */
	id?: string;
}

/** The part of pi's ExtensionContext ask() uses. */
export interface AskContext {
	hasUI?: boolean;
	mode?: string;
	ui?: {
		custom?: (factory: any, options?: any) => Promise<unknown>;
		select?: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
		input?: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>;
	};
}

const cancelled = (reason?: string): AskResult => ({ status: "cancelled", ...(reason ? { reason } : {}) });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Why a request cannot be asked, or undefined. */
export function invalidRequest(request: AskRequest | undefined): string | undefined {
	if (!request || !Array.isArray(request.questions) || request.questions.length === 0) return "no questions";
	const ids = new Set<string>();
	for (const q of request.questions) {
		if (!q || typeof q.id !== "string" || typeof q.title !== "string") return "every question needs an id and a title";
		if (ids.has(q.id)) return `duplicate question id: ${q.id}`;
		ids.add(q.id);
		if (!Array.isArray(q.options)) return `question ${q.id}: options must be an array`;
		if (q.options.length === 0 && q.freeAnswer === false) return `question ${q.id}: no options and no free answer`;
	}
	const review = request.review;
	if (review !== undefined && typeof review !== "function" && !(Array.isArray(review?.options) && review.options.length > 0))
		return "review without options";
	return undefined;
}

/** Label of the dialog in events: the request title or the first question's title. */
export function requestLabel(request: AskRequest): string {
	return request.title ?? request.questions[0]?.title ?? "";
}

/** The settled `memo-question` answer: per question the free answer or the labels; null if not answered. */
export function answerSummary(request: AskRequest, result: AskResult): string | null {
	if (result.status !== "answered") return null;
	return request.questions
		.map((q) => result.answers[q.id])
		.filter((a): a is QuestionResult => !!a)
		.map((a) => a.custom ?? a.labels.join(", "))
		.join(" | ");
}

export async function ask(ctx: AskContext, request: AskRequest, opts: AskOptions = {}): Promise<AskResult> {
	const invalid = invalidRequest(request);
	if (invalid) return cancelled(`invalid request: ${invalid}`);
	if (!ctx?.hasUI || !ctx.ui) return cancelled("no UI available (non-interactive mode)");
	if (opts.signal?.aborted) return { status: "aborted" };

	const id = opts.id ?? randomUUID();
	const label = requestLabel(request);
	const audience = request.audience === "user" ? { audience: "user" as const } : {};
	const emit = (name: string, data: unknown) => {
		try {
			opts.pi?.events?.emit(name, data);
		} catch {
			/* listeners never break the dialog */
		}
	};
	emit(QUESTION_EVENT, { id, question: label, pending: true, ...audience } satisfies QuestionEvent);
	emit("herdr:blocked", { active: true, label });
	let result: AskResult = cancelled();
	try {
		result = await run(ctx, request, opts.signal);
	} catch (error) {
		result = opts.signal?.aborted ? { status: "aborted" } : cancelled(message(error));
	} finally {
		emit("herdr:blocked", { active: false });
		emit(QUESTION_EVENT, {
			id,
			question: label,
			pending: false,
			answer: answerSummary(request, result),
			...audience,
		} satisfies QuestionEvent);
	}
	return result;
}

async function run(ctx: AskContext, request: AskRequest, signal?: AbortSignal): Promise<AskResult> {
	const ui = ctx.ui!;
	const tuiMode = ctx.mode === undefined || ctx.mode === "tui";
	if (typeof ui.custom === "function" && tuiMode) {
		let value: unknown;
		try {
			const factory = (tui: any, theme: any, _keybindings: unknown, done: (r: AskResult) => void) =>
				askComponent(tui, theme, request, done, { signal });
			(factory as any)[ASK_AUDIENCE] = request.audience ?? "any";
			value = await ui.custom(factory);
		} catch {
			value = undefined; // custom UI failed: fall back to select
		}
		if (signal?.aborted) return { status: "aborted" };
		if (value !== undefined) return fromCustom(value, request);
	}
	if (typeof ui.select !== "function") return cancelled("no dialog UI available");
	return fallback(ctx, request, signal);
}

/** Legacy dialog result (`pi-memo-question/dialog` QuestionAnswer), e.g. returned by a router. */
function isLegacyAnswer(value: any): value is { answer: string; custom: boolean; index?: number; note?: string } {
	return typeof value === "object" && value !== null && typeof value.answer === "string" && typeof value.custom === "boolean";
}

function fromCustom(value: unknown, request: AskRequest): AskResult {
	if (isDialogResult(value)) return value;
	if (request.audience === "user")
		return cancelled("the answer did not come from the user's dialog (audience: user)");
	if (value === null) return cancelled();
	// A router (pi-memo-subagents' ask-parent) answered the single question of the `question` tool.
	if (isLegacyAnswer(value) && request.questions.length === 1) {
		const q = request.questions[0];
		if (value.custom) return { status: "answered", answers: { [q.id]: { indices: [], labels: [], custom: value.answer } } };
		const index = typeof value.index === "number" ? value.index - 1 : q.options.findIndex((o) => o.label === value.answer);
		return {
			status: "answered",
			answers: { [q.id]: { indices: index >= 0 ? [index] : [], labels: [value.answer], ...(value.note ? { note: value.note } : {}) } },
		};
	}
	return cancelled("unexpected dialog result");
}

// ---------------------------------------------------------------------------------------------------------
// Fallback without custom UI: one ctx.ui.select per question, readable text (never JSON).

function pageText(title: string, context: string[] | undefined, body: string | undefined, position?: string): string {
	const parts = [`${position ? `(${position}) ` : ""}${title}`];
	if (context?.length) parts.push(context.join("\n"));
	if (body?.trim()) parts.push(body.trim());
	return parts.join("\n\n");
}

function optionText(o: AskOption): string {
	return o.description ? `${o.label} — ${o.description}` : o.label;
}

/** Distinct display strings (a repeated one gets " (n)"), so the choice maps back to its index. */
function distinct(labels: string[]): string[] {
	const seen = new Set<string>();
	return labels.map((l, i) => {
		let s = l;
		if (seen.has(s)) s = `${l} (${i + 1})`;
		seen.add(s);
		return s;
	});
}

type Step<T> = { ok: true; value: T } | { ok: false; result: AskResult };
const stop = (signal?: AbortSignal): Step<never> => ({ ok: false, result: signal?.aborted ? { status: "aborted" } : cancelled() });

/** select over `labels` (index order) with `first` moved to the top; returns the chosen index. */
async function choose(
	ctx: AskContext,
	title: string,
	labels: string[],
	first: number,
	signal?: AbortSignal,
): Promise<Step<number>> {
	const order = labels.map((_, i) => i);
	if (first > 0 && first < labels.length) {
		order.splice(first, 1);
		order.unshift(first);
	}
	const shown = distinct(order.map((i) => labels[i]));
	const picked = await ctx.ui!.select!(title, shown, { signal });
	const at = picked === undefined ? -1 : shown.indexOf(picked);
	if (at < 0 || signal?.aborted) return stop(signal);
	return { ok: true, value: order[at] };
}

async function freeText(ctx: AskContext, title: string, signal?: AbortSignal): Promise<Step<string | undefined>> {
	if (typeof ctx.ui!.input !== "function") return { ok: true, value: undefined };
	const text = await ctx.ui!.input!(title, FREE_ANSWER, { signal });
	if (text === undefined || signal?.aborted) return stop(signal);
	return { ok: true, value: text.trim() || undefined };
}

async function fallbackQuestion(ctx: AskContext, q: Question, position: string | undefined, signal?: AbortSignal): Promise<Step<QuestionResult>> {
	const title = pageText(q.title, q.context, q.body, position);
	// The free answer needs ctx.ui.input; without it the row is not offered.
	const free = q.freeAnswer !== false && typeof ctx.ui!.input === "function";
	const options = q.options.map(optionText);
	const initial = (q.initial === undefined ? [] : Array.isArray(q.initial) ? q.initial : [q.initial]).filter(
		(i) => Number.isInteger(i) && i >= 0 && i < q.options.length,
	);
	if (!q.multiSelect) {
		for (;;) {
			const step = await choose(ctx, title, free ? [...options, FREE_ANSWER] : options, initial[0] ?? 0, signal);
			if (!step.ok) return step;
			if (step.value < q.options.length)
				return { ok: true, value: { indices: [step.value], labels: [q.options[step.value].label] } };
			const text = await freeText(ctx, title, signal);
			if (!text.ok) return text;
			if (text.value) return { ok: true, value: { indices: [], labels: [], custom: text.value } };
		}
	}
	// multiSelect: "Done" first (keeps the checked options), then every option to check/uncheck, in order.
	const checked = new Set(initial);
	for (;;) {
		const done = `Done (${checked.size} selected)`;
		const rows = [done, ...options.map((o, i) => `${checked.has(i) ? "[x]" : "[ ]"} ${o}`), ...(free ? [FREE_ANSWER] : [])];
		const step = await choose(ctx, title, rows, 0, signal);
		if (!step.ok) return step;
		const indices = [...checked].sort((a, b) => a - b);
		const value = { indices, labels: indices.map((i) => q.options[i].label) };
		if (step.value === 0) return { ok: true, value };
		if (step.value <= options.length) {
			const i = step.value - 1;
			if (checked.has(i)) checked.delete(i);
			else checked.add(i);
			continue;
		}
		const text = await freeText(ctx, title, signal);
		if (!text.ok) return text;
		if (text.value) return { ok: true, value: { ...value, custom: text.value } };
	}
}

async function fallback(ctx: AskContext, request: AskRequest, signal?: AbortSignal): Promise<AskResult> {
	try {
		const answers: Answers = {};
		const n = request.questions.length;
		for (const [i, q] of request.questions.entries()) {
			const step = await fallbackQuestion(ctx, q, n > 1 ? `${i + 1}/${n}` : undefined, signal);
			if (!step.ok) return step.result;
			answers[q.id] = step.value;
		}
		const spec: ReviewSpec | null | undefined =
			typeof request.review === "function" ? request.review(answers) : request.review;
		if (!spec) return { status: "answered", answers };
		if (!Array.isArray(spec.options) || spec.options.length === 0) return cancelled("review without options");
		const initial = Number.isInteger(spec.initial) ? spec.initial! : 0;
		const step = await choose(ctx, pageText(spec.title, spec.context, spec.body), spec.options.map(optionText), initial, signal);
		if (!step.ok) return step.result;
		return { status: "answered", answers, review: { index: step.value, label: spec.options[step.value].label } };
	} catch (error) {
		return signal?.aborted ? { status: "aborted" } : cancelled(message(error));
	}
}
