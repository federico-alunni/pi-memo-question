// The dialog of `ask()` (src/ask.ts), for extension code: one or more questions (pages), each with a fixed header
// (title, context lines), an optional scrollable markdown body, options with descriptions, single or
// multiple selection, an optional note (Tab) and an optional free answer ("Type something."), plus an
// optional final review page. Everything fits in the terminal height (tui.terminal.rows, read at every
// render). Originally adapted from the Pi `question` example extension (MIT, @earendil-works/pi-coding-agent
// examples/extensions/question.ts).
//
// Keys (also shown in the hint at the bottom of the dialog):
//   ↑/↓            move between options; on a page whose body does not fit, they scroll the body instead
//   PgUp/PgDn      scroll the body by a page; Home/End go to its top/bottom
//   Shift+↑/↓, 1-9 move between options (always; the way to choose while ↑/↓ scroll the body)
//   ←/→            previous/next question (dialogs with more than one page)
//   Space          multiSelect: check/uncheck the option
//   Tab            add a note to the option (when notes are enabled)
//   Enter          answer the question (multiSelect: confirm the checked options); on "Type something."
//                  open the free answer editor. Ignored for `guardMs` after the dialog/review page opens.
//   Esc            in the note/free answer editor: back to the options; anywhere else: cancel the whole dialog
import { Editor, Key, Markdown, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EditorTheme, MarkdownTheme, TUI } from "@earendil-works/pi-tui";

import { FREE_ANSWER } from "./dialog.ts";

export { FREE_ANSWER };
/** Default Enter guard (ms) for consent dialogs: any question with `freeAnswer: false`, or a review page. */
export const DEFAULT_GUARD_MS = 600;
/** Rows left to pi below the dialog (footer, status). */
export const RESERVED_ROWS = 4;

export interface AskOption {
	label: string;
	description?: string;
}

export interface Question {
	/** Key of this question in `answers`. */
	id: string;
	title: string;
	/** Fixed lines under the title (e.g. repository, `SHA → branch`); truncated to the width. */
	context?: string[];
	/** Markdown; scrolls when it does not fit (title, context and options stay fixed). */
	body?: string;
	options: AskOption[];
	/** Preselected option (0-based); with `multiSelect` the preselected options (`number[]`). */
	initial?: number | number[];
	/** Space checks/unchecks, Enter confirms. */
	multiSelect?: boolean;
	/** "Type something." row (default true). */
	freeAnswer?: boolean;
	/** Note on an option with Tab (default true). */
	notes?: boolean;
}

/** The final review/confirmation page (single choice, no free answer, no notes). */
export interface ReviewSpec {
	title: string;
	context?: string[];
	body?: string;
	options: AskOption[];
	/** Preselected option (0-based), e.g. the safe "No". */
	initial?: number;
}

export interface QuestionResult {
	/** Chosen options, 0-based, in option order (one for single choice, empty for a free answer). */
	indices: number[];
	labels: string[];
	/** Free answer text ("Type something."). */
	custom?: string;
	note?: string;
}

export type Answers = Record<string, QuestionResult>;

export interface AskRequest {
	questions: Question[];
	/** Label of the whole dialog for `memo-question` / `herdr:blocked` (default: the first question's title). */
	title?: string;
	/** Final review page; a function receives the answers and returns the page, or null for none. */
	review?: ReviewSpec | ((answers: Answers) => ReviewSpec | null | undefined);
	/**
	 * Enter is ignored for this long after the dialog opens and after the review page opens, so a key left in
	 * the buffer cannot approve. Default DEFAULT_GUARD_MS when a question has `freeAnswer: false` or there is a
	 * review, otherwise 0.
	 */
	guardMs?: number;
	/**
	 * "user": only the human answers. The answer must come from this dialog's own key handling: a
	 * `ctx.ui.custom` replaced by a router (e.g. pi-memo-subagents' ask-parent) cannot answer for the user.
	 * Default "any" (today's `question` tool: pi-memo-subagents may route it to the parent agent).
	 */
	audience?: "user" | "any";
}

export interface ReviewResult {
	index: number;
	label: string;
}

export type AskResult =
	| { status: "answered"; answers: Answers; review?: ReviewResult }
	| { status: "cancelled"; reason?: string }
	| { status: "aborted" };

export interface DialogTheme {
	fg(color: any, text: string): string;
	bold?(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
	strikethrough?(text: string): string;
}

export interface AskComponent {
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
}

// Results produced by this dialog's own key handling (see `audience`).
const genuine = new WeakSet<object>();
/** True when `value` was produced by an ask dialog (not fabricated by a caller or a router). */
export function isDialogResult(value: unknown): value is AskResult {
	return typeof value === "object" && value !== null && genuine.has(value);
}

/** Effective Enter guard of a request. */
export function guardMsOf(request: AskRequest): number {
	if (typeof request.guardMs === "number" && request.guardMs >= 0) return request.guardMs;
	return request.review || request.questions.some((q) => q.freeAnswer === false) ? DEFAULT_GUARD_MS : 0;
}

interface Row extends AskOption {
	other?: boolean;
}

interface Page {
	kind: "question" | "review";
	title: string;
	context: string[];
	body?: string;
	markdown?: Markdown;
	rows: Row[];
	multi: boolean;
	notes: boolean;
	cursor: number;
	checked: Set<number>;
	scroll: number;
	answer?: QuestionResult;
	question?: Question;
	spec?: ReviewSpec;
}

interface Layout {
	scrollable: boolean;
	viewport: number;
	maxScroll: number;
}

function initialIndices(q: Question): number[] {
	const raw = q.initial === undefined ? [] : Array.isArray(q.initial) ? q.initial : [q.initial];
	return raw.filter((i) => Number.isInteger(i) && i >= 0 && i < q.options.length);
}

function questionPage(q: Question): Page {
	const rows: Row[] = [...q.options];
	if (q.freeAnswer !== false) rows.push({ label: FREE_ANSWER, other: true });
	const initial = initialIndices(q);
	const multi = q.multiSelect === true;
	return {
		kind: "question",
		title: q.title,
		context: q.context ?? [],
		body: q.body,
		rows,
		multi,
		notes: q.notes !== false,
		cursor: initial[0] ?? 0,
		checked: new Set(multi ? initial : []),
		scroll: 0,
		question: q,
	};
}

function reviewPage(spec: ReviewSpec): Page {
	const initial = Number.isInteger(spec.initial) && spec.initial! >= 0 && spec.initial! < spec.options.length ? spec.initial! : 0;
	return {
		kind: "review",
		title: spec.title,
		context: spec.context ?? [],
		body: spec.body,
		rows: [...spec.options],
		multi: false,
		notes: false,
		cursor: initial,
		checked: new Set(),
		scroll: 0,
		spec,
	};
}

function markdownTheme(theme: DialogTheme): MarkdownTheme {
	const fg = (color: string) => (t: string) => {
		try {
			return theme.fg(color, t);
		} catch {
			return t;
		}
	};
	const style = (name: "bold" | "italic" | "underline" | "strikethrough") => (t: string) => {
		try {
			return theme[name]?.(t) ?? t;
		} catch {
			return t;
		}
	};
	return {
		heading: fg("mdHeading"),
		link: fg("mdLink"),
		linkUrl: fg("mdLinkUrl"),
		code: fg("mdCode"),
		codeBlock: fg("mdCodeBlock"),
		codeBlockBorder: fg("mdCodeBlockBorder"),
		quote: fg("mdQuote"),
		quoteBorder: fg("mdQuoteBorder"),
		hr: fg("mdHr"),
		listBullet: fg("mdListBullet"),
		bold: style("bold"),
		italic: style("italic"),
		underline: style("underline"),
		strikethrough: style("strikethrough"),
	};
}

/**
 * The dialog component, for `ctx.ui.custom`. `done` is called once with the result (answered, cancelled
 * or, when `signal` aborts, aborted).
 */
export function askComponent(
	tui: TUI,
	theme: DialogTheme,
	request: AskRequest,
	done: (result: AskResult) => void,
	opts: { signal?: AbortSignal } = {},
): AskComponent {
	const questions = request.questions;
	const pages: Page[] = questions.map(questionPage);
	const multiPage = questions.length > 1 || request.review !== undefined;
	const guardMs = guardMsOf(request);
	let review: Page | undefined;
	let index = 0;
	let editing: "note" | "free" | undefined;
	let guardUntil = Date.now() + guardMs;
	let settled = false;
	let cached: { key: string; lines: string[] } | undefined;
	let layout: Layout | undefined;
	let lastWidth = 0;
	const mdTheme = markdownTheme(theme);
	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const editor = new Editor(tui, editorTheme);

	const page = () => (index < pages.length ? pages[index] : review!);
	const refresh = () => {
		cached = undefined;
		tui.requestRender();
	};
	const onAbort = () => finish({ status: "aborted" });

	function finish(result: AskResult) {
		if (settled) return;
		settled = true;
		opts.signal?.removeEventListener("abort", onAbort);
		genuine.add(result);
		done(result);
	}

	function answers(): Answers {
		const out: Answers = {};
		for (const p of pages) if (p.answer) out[p.question!.id] = p.answer;
		return out;
	}

	function answerPage(p: Page, extra: { custom?: string; note?: string } = {}) {
		if (p.kind === "review") {
			finish({
				status: "answered",
				answers: answers(),
				review: { index: p.cursor, label: p.rows[p.cursor].label },
			});
			return;
		}
		const indices = p.multi ? [...p.checked].sort((a, b) => a - b) : extra.custom !== undefined ? [] : [p.cursor];
		p.answer = {
			indices,
			labels: indices.map((i) => p.rows[i].label),
			...(extra.custom !== undefined ? { custom: extra.custom } : {}),
			...(extra.note ? { note: extra.note } : {}),
		};
		advance();
	}

	function advance() {
		const next = pages.findIndex((p, i) => i > index && !p.answer);
		const first = pages.findIndex((p) => !p.answer);
		if (next >= 0 || first >= 0) return goTo(next >= 0 ? next : first);
		enterReview();
	}

	function enterReview() {
		let spec: ReviewSpec | null | undefined;
		try {
			spec = typeof request.review === "function" ? request.review(answers()) : request.review;
		} catch (error) {
			return finish({ status: "cancelled", reason: `review failed: ${error instanceof Error ? error.message : String(error)}` });
		}
		if (!spec) return finish({ status: "answered", answers: answers() });
		if (!Array.isArray(spec.options) || spec.options.length === 0)
			return finish({ status: "cancelled", reason: "review without options" });
		review = reviewPage(spec);
		goTo(pages.length);
		guardUntil = Date.now() + guardMs;
	}

	function goTo(i: number) {
		index = i;
		editing = undefined;
		editor.setText("");
		layout = undefined;
	}

	editor.onSubmit = (value) => {
		const text = value.trim();
		const p = page();
		if (editing === "note") return answerPage(p, { note: text || undefined });
		if (text) return answerPage(p, { custom: text });
		editing = undefined;
		editor.setText("");
		refresh();
	};

	function scrollBy(p: Page, delta: number) {
		const l = currentLayout();
		p.scroll = Math.max(0, Math.min(l.maxScroll, p.scroll + delta));
	}

	function currentLayout(): Layout {
		if (!layout) render(lastWidth || tui.terminal?.columns || 80);
		return layout!;
	}

	function handleInput(data: string) {
		if (settled) return;
		if (editing) {
			if (matchesKey(data, Key.escape)) {
				editing = undefined;
				editor.setText("");
			} else editor.handleInput(data);
			refresh();
			return;
		}
		const p = page();
		const row = p.rows[p.cursor];
		const move = (delta: number) => (p.cursor = Math.max(0, Math.min(p.rows.length - 1, p.cursor + delta)));
		if (matchesKey(data, Key.escape)) return finish({ status: "cancelled" });
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const delta = matchesKey(data, Key.up) ? -1 : 1;
			if (p.body !== undefined && currentLayout().scrollable) scrollBy(p, delta);
			else move(delta);
		} else if (matchesKey(data, Key.shift("up"))) move(-1);
		else if (matchesKey(data, Key.shift("down"))) move(1);
		else if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.pageDown)) {
			if (p.body === undefined) return;
			const step = Math.max(1, currentLayout().viewport - 1);
			scrollBy(p, matchesKey(data, Key.pageUp) ? -step : step);
		} else if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
			if (p.body === undefined) return;
			scrollBy(p, matchesKey(data, Key.home) ? -Infinity : Infinity);
		} else if (/^[1-9]$/.test(data)) {
			const n = Number(data) - 1;
			if (n >= p.rows.length) return;
			p.cursor = n;
		} else if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			if (!multiPage) return;
			if (matchesKey(data, Key.left)) {
				if (index === 0) return;
				goTo(index - 1);
			} else if (index < pages.length - 1) goTo(index + 1);
			else if (index === pages.length - 1 && pages.every((x) => x.answer)) enterReview();
			else return;
		} else if (matchesKey(data, Key.space) || data === " ") {
			if (!p.multi || row.other) return;
			if (p.checked.has(p.cursor)) p.checked.delete(p.cursor);
			else p.checked.add(p.cursor);
		} else if (matchesKey(data, Key.tab)) {
			if (!p.notes || row.other) return;
			editing = "note";
			editor.setText("");
		} else if (matchesKey(data, Key.enter)) {
			if (Date.now() < guardUntil) return;
			if (row.other) {
				editing = "free";
				if (p.answer?.custom) editor.setText(p.answer.custom);
			} else {
				answerPage(p);
				if (settled) return;
			}
		} else return;
		refresh();
	}

	function hint(p: Page, scrollable: boolean): string {
		if (editing) return "Enter to submit • Esc to go back";
		const parts = [scrollable ? "↑↓ PgUp/PgDn scroll • 1-9 ⇧↑↓ choose" : "↑↓ navigate"];
		if (p.kind === "review") parts.push("← back", "Enter to confirm");
		else {
			if (multiPage) parts.push("←→ questions");
			parts.push(p.multi ? "Space to toggle • Enter to confirm" : "Enter to select");
			if (p.notes) parts.push("Tab to add note");
		}
		parts.push(multiPage ? "Esc to cancel all" : "Esc to cancel");
		return parts.join(" • ");
	}

	function render(width: number): string[] {
		lastWidth = width;
		const rows = tui.terminal?.rows;
		const limit = typeof rows === "number" && rows > 0 ? Math.max(Math.min(rows, 6), rows - RESERVED_ROWS) : Infinity;
		const key = `${width}x${limit}`;
		if (cached?.key === key) return cached.lines;
		const w = Math.max(1, width);
		let lines = build(w, limit, false);
		// Too little room: compact layout (no borders or blank lines, one-line title and hint).
		if (lines.length > limit) lines = build(w, limit, true);
		lines = lines.map((l) => (visibleWidth(l) > w ? truncateToWidth(l, w) : l));
		cached = { key, lines };
		return lines;
	}

	function build(w: number, limit: number, compact: boolean): string[] {
		const p = page();
		const wrap = (prefix: string, text: string): string[] => {
			const pw = visibleWidth(prefix);
			if (pw >= w) return wrapTextWithAnsi(prefix + text, w);
			return wrapTextWithAnsi(text, w - pw).map((l, i) => `${i ? " ".repeat(pw) : prefix}${l}`);
		};
		const one = (prefix: string, text: string) => [truncateToWidth(prefix + text, w)];
		const border = theme.fg("accent", "─".repeat(w));
		const blank = compact ? [] : [""];

		// Header: border, page indicator, title, context.
		const head: string[] = compact ? [] : [border];
		if (multiPage) {
			const marks = pages.map((x, i) =>
				i === index ? theme.fg("accent", `[${i + 1}]`) : theme.fg(x.answer ? "success" : "dim", x.answer ? `✓${i + 1}` : `${i + 1}`),
			);
			if (request.review) marks.push(index === pages.length ? theme.fg("accent", "[Review]") : theme.fg("dim", "Review"));
			const where = index < pages.length ? `${index + 1}/${pages.length}` : "Review";
			head.push(truncateToWidth(` ${theme.fg("accent", where)}  ${marks.join(" ")}`, w));
		}
		head.push(...(compact ? one : wrap)(" ", theme.fg("text", p.title)));
		for (const line of p.context) head.push(truncateToWidth(` ${theme.fg("muted", line)}`, w));
		head.push(...blank);

		// Options, one group of lines per row (the cursor's group is kept visible when trimming).
		const answered = new Set(p.answer?.indices ?? []);
		const groups = p.rows.map((o, i) => {
			const selected = i === p.cursor;
			const box = p.multi && !o.other ? (p.checked.has(i) ? "[x] " : "[ ] ") : "";
			const mark = multiPage && ((!p.multi && answered.has(i)) || (o.other && p.answer?.custom !== undefined)) ? " ✓" : "";
			const text = o.other && p.answer?.custom && editing !== "free" ? `${o.label} (${p.answer.custom})` : o.label;
			const label = `${box}${i + 1}. ${text}${o.other && editing === "free" ? " ✎" : ""}${mark}`;
			const lines = wrap(selected ? theme.fg("accent", "> ") : "  ", theme.fg(selected ? "accent" : "text", label));
			if (o.description) lines.push(...wrap("     ", theme.fg("muted", o.description)));
			return lines;
		});

		// Editor (note / free answer).
		const edit: string[] = [];
		if (editing) {
			edit.push(...blank);
			if (editing === "note") {
				const sel = p.multi
					? `Selected: ${[...p.checked].sort((a, b) => a - b).map((i) => `${i + 1}. ${p.rows[i].label}`).join(", ") || "none"}`
					: `Selected: ${p.cursor + 1}. ${p.rows[p.cursor].label}`;
				edit.push(...(compact ? one : wrap)(" ", theme.fg("accent", sel)));
				if (!compact) edit.push(...wrap(" ", theme.fg("muted", "Add note / comment (optional):")));
			} else edit.push(...(compact ? one : wrap)(" ", theme.fg("muted", "Your answer:")));
			for (const l of editor.render(Math.max(1, w - 2))) edit.push(` ${l}`);
		}

		const foot = (scrollable: boolean) => {
			const text = theme.fg("dim", hint(p, scrollable));
			return compact ? one(" ", text) : ["", ...wrap(" ", text), border];
		};
		const optionCount = groups.reduce((n, g) => n + g.length, 0);

		// Body: all of it when it fits, otherwise a scrolling viewport with a position line.
		let body: string[] = [];
		let tail = foot(false);
		let next: Layout = { scrollable: false, viewport: 0, maxScroll: 0 };
		if (p.body !== undefined) {
			p.markdown ??= new Markdown(p.body, 0, 0, mdTheme);
			const md = p.markdown.render(Math.max(1, w - 2)).map((l) => ` ${l}`);
			const fixed = head.length + optionCount + edit.length;
			if (fixed + md.length + blank.length + tail.length <= limit) {
				body = [...md, ...blank];
				p.scroll = 0;
			} else {
				tail = foot(true);
				const viewport = Math.max(1, limit - fixed - tail.length - 1 - blank.length);
				const maxScroll = Math.max(0, md.length - viewport);
				p.scroll = Math.max(0, Math.min(maxScroll, p.scroll));
				const from = p.scroll;
				const to = Math.min(md.length, from + viewport);
				const up = from > 0 ? "↑" : " ";
				const down = to < md.length ? "↓" : " ";
				body = [
					...md.slice(from, to),
					truncateToWidth(` ${theme.fg("dim", `${up}${down} lines ${from + 1}-${to} of ${md.length}`)}`, w),
					...blank,
				];
				next = { scrollable: true, viewport, maxScroll };
			}
		}
		layout = next;

		// Options window around the cursor when everything else leaves too little room.
		let options = groups.flat();
		const others = head.length + body.length + edit.length + tail.length;
		if (others + options.length > limit) {
			const budget = Math.max(1, limit - others);
			const reserve = budget >= 3 ? 2 : 0; // "↑ n more" / "↓ n more"
			const inner = budget - reserve;
			let lo = p.cursor;
			let hi = p.cursor;
			let used = groups[p.cursor].length;
			for (let grew = true; grew; ) {
				grew = false;
				if (hi + 1 < groups.length && used + groups[hi + 1].length <= inner) {
					used += groups[++hi].length;
					grew = true;
				}
				if (lo > 0 && used + groups[lo - 1].length <= inner) {
					used += groups[--lo].length;
					grew = true;
				}
			}
			const more = (n: number, arrow: string) => theme.fg("dim", `  ${arrow} ${n} more`);
			options = [
				...(reserve && lo > 0 ? [more(lo, "↑")] : []),
				...groups.slice(lo, hi + 1).flat().slice(0, inner),
				...(reserve && hi < groups.length - 1 ? [more(groups.length - 1 - hi, "↓")] : []),
			];
		}

		const top = [...head, ...body];
		const bottom = [...edit, ...tail];
		if (top.length + options.length + bottom.length <= limit || !compact) return [...top, ...options, ...bottom];
		// Still too tall: keep the options window (at least the cursor line), the editor and the hint; cut the header.
		const room = limit - options.length - bottom.length;
		if (room >= 0) return [...top.slice(0, room), ...options, ...bottom];
		const keep = Math.max(1, limit - bottom.length);
		return [...options.slice(0, keep), ...bottom].slice(0, limit);
	}

	if (opts.signal?.aborted) queueMicrotask(onAbort);
	else opts.signal?.addEventListener("abort", onAbort, { once: true });

	return {
		render,
		handleInput,
		invalidate: () => {
			cached = undefined;
			layout = undefined;
			for (const p of [...pages, ...(review ? [review] : [])]) p.markdown?.invalidate();
		},
		dispose: () => opts.signal?.removeEventListener("abort", onAbort),
	};
}
