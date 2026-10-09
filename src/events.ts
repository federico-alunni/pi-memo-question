/**
 * Events emitted on `pi.events` by the `question` tool and by `ask()` (src/ask.ts), for other extensions of
 * the same pi process.
 *
 * - `memo-question`: once with `pending: true` when the dialog opens, once with `pending: false` when it
 *   closes (`answer` is the chosen label or free text, null if cancelled/aborted; for several questions the
 *   answers joined with " | "). pi-memo-subagents' child extension turns these into `question.json`, so the
 *   parent sees the pending question and moves focus.
 * - `herdr:blocked`: `{ active: true, label }` / `{ active: false }`, read by the Herdr agent-state extension.
 */
export const QUESTION_EVENT = "memo-question";

export interface QuestionEvent {
	/** Unique per dialog; the same id is used for the pending and the settled event. */
	id: string;
	question: string;
	pending: boolean;
	/** Only when settled: chosen label or free answer, null if cancelled. */
	answer?: string | null;
	/** Only for `ask()` requests with `audience: "user"`: only the human may answer, never a parent agent. */
	audience?: "user";
}
