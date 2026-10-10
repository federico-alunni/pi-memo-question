// The question dialog: options with descriptions, Tab adds a note to an option, inline free answer,
// Esc cancels. Adapted from the Pi `question` example extension (MIT, @earendil-works/pi-coding-agent
// examples/extensions/question.ts); the questionnaire (tab bar + review) follows its `questionnaire.ts`.
//
// Typing answers too, for remote viewers that can only type text and press Enter (Collie's composer
// on a pi pane sends raw text, then Enter): printable text opens the free answer with that text, and a
// free answer that is an option number (1..N) or an option label picks that option.
//
// `multiple: true` turns it into a multi-select: Space ticks the pointed option, Enter confirms the
// ticked ones (the pointed one when none is ticked), and a typed answer may name several options
// ("1,3", "1-3", "docs, tests").
//
// Several questions are one questionnaire: a tab per question, a last "Review" tab that sums up the
// answers, ←/→ or Tab to move between tabs.
import { decodeKittyPrintable, Editor, Key, matchesKey, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";

export interface QuestionOption {
	label: string;
	description?: string;
}

/**
 * Chosen option (1-based index, optional note), several chosen options (`multi`, with an optional free
 * text next to them) or a free answer; null = cancelled.
 */
export type QuestionAnswer =
	| { answer: string; custom: false; index: number; note?: string }
	| { answer: string; custom: false; multi: true; indexes: number[]; labels: string[]; other?: string }
	| { answer: string; custom: true };

interface Theme {
	fg(color: any, text: string): string;
	bg?(color: any, text: string): string;
	bold?(text: string): string;
}

export interface QuestionSettings {
	/** Let the user pick several options (default: one). */
	multiple?: boolean;
	/** A page of a questionnaire: no frame, footer or note (Tab) of its own; the questionnaire draws them. */
	embedded?: boolean;
	/** The answer already recorded for this question, to mark it in the list. */
	answered?: () => QuestionAnswer | null;
}

export const FREE_ANSWER = "Type something.";

const RECOMMENDED = /\s*\(recommended\)\s*$/i;

/** The printable text `data` carries (a key or a chunk of typed text), or undefined for keys/controls. */
function printableText(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty.trim() ? kitty : undefined;
	if (!data.trim() || data.startsWith("\x1b")) return undefined;
	for (const ch of data) {
		const code = ch.codePointAt(0) ?? 0;
		if (code < 32 || code === 127) return undefined;
	}
	return data;
}

/** Push `text` wrapped to `w`, `prefix` on the first row and its width of spaces on the next ones. */
function addWrapped(lines: string[], w: number, prefix: string, text: string) {
	const pw = visibleWidth(prefix);
	if (pw >= w) return void lines.push(...wrapTextWithAnsi(prefix + text, w));
	wrapTextWithAnsi(text, w - pw).forEach((l, i) => lines.push(`${i ? " ".repeat(pw) : prefix}${l}`));
}

/** The 0-based option a typed answer names (its number or its label, "(Recommended)" optional), if any. */
export function matchOption(options: QuestionOption[], text: string): number | undefined {
	const t = text.trim();
	if (/^\d+$/.test(t)) {
		const n = Number(t);
		return n >= 1 && n <= options.length ? n - 1 : undefined;
	}
	const norm = (s: string) => s.replace(RECOMMENDED, "").trim().toLowerCase();
	const i = options.findIndex((o) => o.label.trim().toLowerCase() === t.toLowerCase() || norm(o.label) === norm(t));
	return i >= 0 ? i : undefined;
}

/**
 * The 0-based options a typed multi-select answer names, sorted, or undefined when any part of the text is
 * not an option (then the whole text is a free answer). Parts are separated by commas or semicolons, or by
 * spaces when every part is a number; `2-4` is a range. A label that itself contains a comma still matches.
 */
export function matchOptions(options: QuestionOption[], text: string): number[] | undefined {
	const t = text.trim();
	if (!t) return undefined;
	const whole = matchOption(options, t);
	if (whole !== undefined) return [whole];
	let parts = t.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
	if (parts.length === 1 && /^\d+(\s+\d+)+$/.test(parts[0])) parts = parts[0].split(/\s+/);
	const picks = new Set<number>();
	for (const part of parts) {
		const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
		if (range) {
			const from = Number(range[1]);
			const to = Number(range[2]);
			if (from < 1 || to < from || to > options.length) return undefined;
			for (let n = from; n <= to; n++) picks.add(n - 1);
			continue;
		}
		const i = matchOption(options, part);
		if (i === undefined) return undefined;
		picks.add(i);
	}
	return [...picks].sort((a, b) => a - b);
}

/** "2. Push" or, for several, "1. Docs, 3. Tests". */
export function describeSelection(result: Extract<QuestionAnswer, { custom: false }>): string {
	if ("multi" in result) return result.indexes.map((n, k) => `${n}. ${result.labels[k]}`).join(", ");
	return `${result.index}. ${result.answer}`;
}

export function questionComponent(
	tui: TUI,
	theme: Theme,
	question: string,
	options: QuestionOption[],
	done: (result: QuestionAnswer | null) => void,
	settings: QuestionSettings = {},
) {
	const multiple = settings.multiple === true;
	const embedded = settings.embedded === true;
	const all: (QuestionOption & { other?: boolean })[] = [...options, { label: FREE_ANSWER, other: true }];
	const ticked = new Set<number>();
	let index = 0;
	let editing = false;
	let noting = false;
	let cached: string[] | undefined;
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
	const refresh = () => {
		cached = undefined;
		tui.requestRender();
	};
	/** Close the answer field, then report. The page of a questionnaire stays alive and may be answered again. */
	const finish = (result: QuestionAnswer | null) => {
		editing = noting = false;
		editor.setText("");
		done(result);
	};

	/** The answer for these 0-based options plus an optional free text (multi-select). */
	function multiAnswer(picks: number[], other?: string): QuestionAnswer {
		ticked.clear();
		for (const i of picks) ticked.add(i);
		const labels = picks.map((i) => options[i].label);
		return {
			answer: [...labels, ...(other ? [other] : [])].join(", "),
			custom: false,
			multi: true,
			indexes: picks.map((i) => i + 1),
			labels,
			...(other ? { other } : {}),
		};
	}

	editor.onSubmit = (value) => {
		const text = value.trim();
		if (noting) return finish({ answer: all[index].label, custom: false, index: index + 1, note: text || undefined });
		if (!text) {
			editing = false;
			editor.setText("");
			return refresh();
		}
		if (multiple) {
			const named = matchOptions(options, text);
			if (named) return finish(multiAnswer([...new Set([...ticked, ...named])].sort((a, b) => a - b)));
			if (ticked.size) return finish(multiAnswer([...ticked].sort((a, b) => a - b), text));
			return finish({ answer: text, custom: true });
		}
		const pick = matchOption(options, text);
		if (pick !== undefined) finish({ answer: options[pick].label, custom: false, index: pick + 1 });
		else finish({ answer: text, custom: true });
	};

	function handleInput(data: string) {
		if (editing) {
			if (matchesKey(data, Key.escape)) {
				editing = noting = false;
				editor.setText("");
			} else editor.handleInput(data);
			refresh();
			return;
		}
		if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
		else if (matchesKey(data, Key.down)) index = Math.min(all.length - 1, index + 1);
		else if (multiple && matchesKey(data, Key.space)) {
			if (all[index].other) return;
			if (!ticked.delete(index)) ticked.add(index);
		} else if (matchesKey(data, Key.tab)) {
			if (all[index].other || multiple || embedded) return;
			editing = noting = true;
			editor.setText("");
		} else if (matchesKey(data, Key.enter)) {
			if (all[index].other) {
				editing = true;
				noting = false;
			} else if (multiple) {
				const picks = ticked.size ? [...ticked].sort((a, b) => a - b) : [index];
				return finish(multiAnswer(picks));
			} else return finish({ answer: all[index].label, custom: false, index: index + 1 });
		} else if (matchesKey(data, Key.escape)) return finish(null);
		else if (printableText(data) !== undefined) {
			// Typing answers: open the free answer with what was typed (a number or a label picks an option).
			editing = true;
			noting = false;
			editor.setText("");
			editor.handleInput(data);
		} else return;
		refresh();
	}

	/** Whether option row `i` is the single-choice (or free) answer already recorded. */
	function isRecorded(i: number): boolean {
		const a = settings.answered?.();
		if (!a) return false;
		if (a.custom) return all[i].other === true;
		if ("multi" in a) return all[i].other === true ? a.other !== undefined : a.indexes.includes(i + 1);
		return a.index === i + 1;
	}

	/** The question, its options and the answer field: everything but the frame and the footer. */
	function body(w: number): string[] {
		const lines: string[] = [];
		const add = (prefix: string, text: string) => addWrapped(lines, w, prefix, text);
		add(" ", theme.fg("text", question));
		if (multiple) add(" ", theme.fg("muted", "Pick one or more options."));
		lines.push("");
		all.forEach((o, i) => {
			const selected = i === index;
			const box = multiple ? (o.other ? "    " : ticked.has(i) ? "[x] " : "[ ] ") : "";
			const label = `${box}${i + 1}. ${o.label}${o.other && editing && !noting ? " ✎" : ""}`;
			add(
				selected ? theme.fg("accent", "> ") : "  ",
				theme.fg(selected ? "accent" : "text", label) + (isRecorded(i) ? theme.fg("success", " ✓") : ""),
			);
			if (o.description) add(multiple ? "         " : "     ", theme.fg("muted", o.description));
		});
		if (editing) {
			lines.push("");
			if (noting) {
				add(" ", theme.fg("accent", `Selected: ${index + 1}. ${all[index].label}`));
				add(" ", theme.fg("muted", "Add note / comment (optional):"));
			} else if (multiple)
				add(" ", theme.fg("muted", "Your answer (option numbers like 1,3 or labels pick those options):"));
			else add(" ", theme.fg("muted", "Your answer (an option number or label picks that option):"));
			for (const l of editor.render(Math.max(1, w - 2))) lines.push(` ${l}`);
		}
		return lines;
	}

	function footer(): string {
		if (editing) return "Enter to submit • Esc to go back";
		// Inside a questionnaire the footer also carries "←→ tabs •": keep it to one line at 80 columns.
		if (embedded)
			return multiple
				? "↑↓ navigate • Space tick • Enter confirm • type 1,3 • Esc cancel"
				: "↑↓ navigate • Enter select • type a number or text • Esc cancel";
		if (multiple) return "↑↓ navigate • Space to tick • Enter to confirm • type numbers (1,3) or an answer • Esc to cancel";
		return "↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel";
	}

	function render(width: number): string[] {
		if (cached) return cached;
		const w = Math.max(1, width);
		if (embedded) return (cached = body(w));
		const lines = [theme.fg("accent", "─".repeat(w)), ...body(w), ""];
		addWrapped(lines, w, " ", theme.fg("dim", footer()));
		lines.push(theme.fg("accent", "─".repeat(w)));
		return (cached = lines);
	}

	return { render, handleInput, invalidate: () => void (cached = undefined), isEditing: () => editing, footer };
}

export interface QuestionnaireItem {
	question: string;
	options: QuestionOption[];
	multiple?: boolean;
	/** Very short label of the tab; "Q1", "Q2"… when absent. */
	header?: string;
}

const TAB_LABEL_MAX = 14;

/**
 * Several questions in one dialog: a tab bar (▢ open, ▣ answered, ✓ Review), one page per question and a last
 * Review tab that sums up the answers. ←/→ and Tab / Shift+Tab move between tabs, answering moves on to the next
 * open question, Enter on Review submits (or goes to the first open question). Esc cancels all of it: `done(null)`.
 */
export function questionnaireComponent(
	tui: TUI,
	theme: Theme,
	items: QuestionnaireItem[],
	done: (answers: QuestionAnswer[] | null) => void,
) {
	const n = items.length;
	const answers: (QuestionAnswer | null)[] = items.map(() => null);
	let tab = 0; // n = the Review tab
	let cached: string[] | undefined;
	const refresh = () => {
		cached = undefined;
		tui.requestRender();
	};
	const headerOf = (i: number) => {
		const h = items[i].header?.trim() || `Q${i + 1}`;
		return h.length > TAB_LABEL_MAX ? `${h.slice(0, TAB_LABEL_MAX - 1)}…` : h;
	};
	/** The open question to go to after answering `i`: the next one, else any other, else Review. */
	const nextTab = (i: number) => {
		for (let k = 1; k < n; k++) {
			const j = (i + k) % n;
			if (answers[j] === null) return j;
		}
		return n;
	};

	const pages = items.map((item, i) =>
		questionComponent(
			tui,
			theme,
			item.question,
			item.options,
			(result) => {
				if (result === null) return done(null);
				answers[i] = result;
				tab = nextTab(i);
				refresh();
			},
			{ multiple: item.multiple === true, embedded: true, answered: () => answers[i] },
		),
	);

	function handleInput(data: string) {
		const page = pages[tab];
		if (page?.isEditing()) {
			page.handleInput(data);
			refresh();
			return;
		}
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
			tab = (tab + 1) % (n + 1);
			return refresh();
		}
		if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
			tab = (tab - 1 + n + 1) % (n + 1);
			return refresh();
		}
		if (!page) {
			// Review. Typed text is ignored on purpose: a viewer that can only type text then press Enter
			// (Collie's reply box) confirms with any text followed by Enter.
			if (matchesKey(data, Key.enter)) {
				const open = answers.findIndex((a) => a === null);
				if (open < 0) return done(answers as QuestionAnswer[]);
				tab = open;
				refresh();
			} else if (matchesKey(data, Key.escape)) done(null);
			return;
		}
		page.handleInput(data);
		refresh();
	}

	function tabBar(w: number): string[] {
		// Semantic colors only, so any theme works: the active tab is accent + bold on the selection background,
		// an answered one is success, an open one plain text, Review is success once everything is answered.
		const hl = (text: string) => {
			const accent = theme.fg("accent", theme.bold ? theme.bold(text) : text);
			return theme.bg ? theme.bg("selectedBg", accent) : accent;
		};
		const build = (compact: boolean) => {
			const parts = [theme.fg("dim", "←")];
			items.forEach((_, i) => {
				const answered = answers[i] !== null;
				const text = ` ${answered ? "▣" : "▢"}  ${compact ? i + 1 : headerOf(i)} `;
				parts.push(i === tab ? hl(text) : theme.fg(answered ? "success" : "text", text));
			});
			const ready = answers.every((a) => a !== null);
			const review = ` ✓${compact ? "" : " Review"} `;
			parts.push(tab === n ? hl(review) : theme.fg(ready ? "success" : "dim", review), theme.fg("dim", "→"));
			return parts.join(" ");
		};
		let bar = build(false);
		if (visibleWidth(bar) + 1 > w) bar = build(true);
		return wrapTextWithAnsi(` ${bar}`, w);
	}

	/** One answer on one line of the review, styled. */
	function summary(i: number): string {
		const a = answers[i];
		if (!a) return theme.fg("warning", "— not answered");
		if (a.custom) return theme.fg("muted", "(wrote) ") + theme.fg("text", a.answer);
		if ("multi" in a)
			return theme.fg("text", a.labels.join(", ")) + (a.other ? theme.fg("muted", ` (+ ${a.other})`) : "");
		return theme.fg("text", a.answer) + (a.note ? theme.fg("muted", ` (note: ${a.note})`) : "");
	}

	function review(w: number): string[] {
		const lines: string[] = [];
		const add = (prefix: string, text: string) => addWrapped(lines, w, prefix, text);
		add(" ", theme.fg("accent", theme.bold ? theme.bold("Review your answers") : "Review your answers"));
		lines.push("");
		const names = items.map((_, i) => `${i + 1}. ${headerOf(i)}`);
		const pad = Math.max(...names.map((s) => s.length));
		items.forEach((_, i) => add(` ${theme.fg("muted", names[i].padEnd(pad))}  `, summary(i)));
		lines.push("");
		const open = items.flatMap((_, i) => (answers[i] === null ? [headerOf(i)] : []));
		if (open.length) add(" ", theme.fg("warning", `Unanswered: ${open.join(", ")}`));
		else add(" ", theme.fg("success", "✓ All answered — Enter to submit"));
		return lines;
	}

	function footer(): string {
		const page = pages[tab];
		if (page?.isEditing()) return page.footer();
		if (!page) {
			const ready = answers.every((a) => a !== null);
			return `←→ tabs • ${ready ? "Enter submit" : "Enter goes to the first unanswered"} • Esc cancel`;
		}
		return `←→ tabs • ${page.footer()}`;
	}

	function render(width: number): string[] {
		if (cached) return cached;
		const w = Math.max(1, width);
		const page = pages[tab];
		page?.invalidate(); // its marks depend on the answers kept here
		const lines = [theme.fg("accent", "─".repeat(w)), ...tabBar(w), ""];
		lines.push(...(page ? page.render(w) : review(w)), "");
		addWrapped(lines, w, " ", theme.fg("dim", footer()));
		lines.push(theme.fg("accent", "─".repeat(w)));
		return (cached = lines);
	}

	return { render, handleInput, invalidate: () => void ((cached = undefined), pages.forEach((p) => p.invalidate())) };
}

/** Text returned to the model for an answer (null = cancelled). */
export function answerText(result: QuestionAnswer | null): string {
	if (!result) return "User cancelled the selection";
	if (result.custom) return `User wrote: ${result.answer}`;
	if ("multi" in result)
		return `User selected: ${describeSelection(result)}${result.other ? `\nUser also wrote: ${result.other}` : ""}`;
	return `User selected: ${describeSelection(result)}${result.note ? `\nUser note: ${result.note}` : ""}`;
}
