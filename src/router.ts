/**
 * Question router: lets the host of an agent (e.g. pi-memo-subagents in a subagent process) answer a `question`
 * call before it reaches the user, typically by asking the agent that started this one.
 *
 * The router is a process-wide registration on `globalThis[Symbol.for("pi-memo-question/router")]`: a host sets it
 * without importing this package (the key is a registered symbol), so there is always exactly one `question` tool,
 * the one of the installed package. Without a router every question goes to the user, as before.
 */
import type { QuestionAnswer, QuestionOption } from "./dialog.ts";

export const QUESTION_ROUTER_KEY = Symbol.for("pi-memo-question/router");

/** Who should answer: the human (`user`) or the agent that started this one (`parent`). */
export type QuestionTarget = "user" | "parent";

export interface RoutedQuestion {
	/** Same id as the `memo-question` events of this call. */
	id: string;
	question: string;
	options: QuestionOption[];
}

export type RouteOutcome =
	/** Answered without the dialog. `by` names who answered, for the model ("the parent agent"). */
	| { kind: "answered"; answer: QuestionAnswer | null; by: string; note?: string; details?: Record<string, unknown> }
	/** Ask the user with the dialog here; `reason` is appended to the result for the model. */
	| { kind: "user"; reason?: string }
	/** Withdrawn (e.g. the turn was aborted). */
	| { kind: "cancelled" };

export interface QuestionRouter {
	/** Target of a call without `to`. */
	defaultTarget(): QuestionTarget;
	/** Ask the parent. Never throws for routine failures: `{ kind: "user" }` falls back to the dialog. */
	askParent(question: RoutedQuestion, signal: AbortSignal | undefined): Promise<RouteOutcome>;
}

export function currentRouter(): QuestionRouter | undefined {
	const router = (globalThis as Record<symbol, unknown>)[QUESTION_ROUTER_KEY] as QuestionRouter | undefined;
	return router && typeof router.askParent === "function" && typeof router.defaultTarget === "function"
		? router
		: undefined;
}

export function setRouter(router: QuestionRouter | undefined): void {
	(globalThis as Record<symbol, unknown>)[QUESTION_ROUTER_KEY] = router;
}
