# pi-memo-question

The `question` tool for [pi](https://pi.dev): one or more questions to the user with options (recommended option
first), a description under each option, single or multiple choice, an optional note on an option (Tab, single
choice) and a free answer ("Type something.").

Input: `{ questions: [{ question, header?, options: [{ label, description? }], multiple? }], to? }` with 1 to 9 questions.
`header` is a very short label (max ~14 characters) for the question's tab when there are several (`Q1`, `Q2`… on absent).
The list shape is the one other question tools use (Claude Code's AskUserQuestion, opencode's `question`), so viewers
that read the pi session log, such as [Collie](https://github.com/AltanS/collie), draw each question with its options.
The pre-0.3 top-level `{ question, options }` is still accepted by `execute` for direct callers (one question).

## Several questions, multiple choice

- **Several questions** are one questionnaire dialog: a tab bar (`▢` open, `▣` answered, `✓ Review`),
  one page per question and a last **Review** tab that sums up the answers. `←`/`→` or Tab / Shift+Tab
  move between tabs; answering goes to the next open question; Enter on Review submits (or goes to the first open
  question); Esc cancels all of it. Notes (Tab) are not available there. On a narrow screen the tabs shrink to
  numbers. The result has one entry per question, each under `[i/N] question`. Typed text on Review is ignored, so a
  viewer that can only type text confirms with any text followed by Enter.
- With `to: "parent"` (or when the parent cannot answer) the questions are asked one at a time, the parent first;
  cancelling one ends the call and the later ones are not asked. Events (`memo-question`, `herdr:blocked`) are one
  pair per dialog: for a questionnaire the question reads `first question (+N more)`.
- **`multiple: true`** makes a question multiple choice: `Space` ticks the pointed option, `Enter` confirms the ticked
  ones (the pointed one when none is ticked), `Esc` cancels. Notes (Tab) are single-choice only. The free answer row
  adds text next to the ticked options.

## Typed answers

Besides arrows/Enter/Tab/Esc, typing in the dialog opens the free answer with the typed text. On Enter, a free answer
that is an option's number (`1`…`N`) or its label (case-insensitive, `(Recommended)` optional) picks that option;
anything else is a free answer. In a multiple-choice question the text may name several options: `1,3`, `1 3`, `1-3`,
`docs, tests` (a label containing a comma still matches whole); text that is not all options is a free answer, kept
next to the ticked options if there are any. This is what makes the dialog answerable from a viewer that can only type
text and press Enter, such as Collie's reply box on a pi pane (it sends the raw text, then Enter).

For extension code there is **`ask()`** (`pi-memo-question/ask`, see [below](#ask--questions-from-extension-code)):
the same kind of dialog, called by a tool or command instead of the model, with a structured result. The user
answers, never the model, never a parent agent. It adds what consent decisions need: a fixed header with context
lines, a scrollable markdown body, a preselected option, a review page that depends on the answers, an Enter guard
and a select fallback without custom UI.

It is the **only** question dialog of the memo extensions:

| Who | How it gets it |
|---|---|
| main agent (`pi`) | installed as a pi package, see [Install](#install-collaborators) |
| `pi-ir` | `pi -e <path of the installed package>` (`pi list` shows it); its own decisions call `ask()` |
| [pi-memo-subagents](https://github.com/federico-alunni/pi-memo-subagents) children (`subagent` tool, Issue Round agents) | the installed package: profile children load it with the profile, isolated ones with `-e <installed package>/extensions/question.ts`. pi loads the same path once, so it never conflicts |

Every agent uses the **installed** package (updated with `pi update --extensions`); nothing bundles a copy of it.
`exports` exposes `./extension`, `./ask`, `./dialog`, `./events`, `./router` and `./package.json` (types and tests).

## Install (collaborators)

```bash
pi install git:github.com/federico-alunni/pi-memo-question        # latest main
pi install git:github.com/federico-alunni/pi-memo-question@beta   # beta channel (prereleases)
pi update --extensions                                            # pull new versions
```

Without a `@ref` pi follows `main`, so `pi update --extensions` picks up new commits. Pinning a release
(`…pi-memo-question@v0.3.0`) freezes that tag: `pi update` will not move it, re-run `pi install` with the new tag.

> **Warning — load it from one source only.** If you already load this package from a local checkout
> (a path in `settings.json` `packages`, `pi -e <path>`, or a `file:` dependency), do **not** also install the git
> source: pi identifies packages by repo URL or absolute path, so the same `question` tool could be loaded twice.
> Remove one of the two.

## `ask()` — questions from extension code

```ts
import { ask } from "pi-memo-question/ask"; // or globalThis[Symbol.for("pi-memo-question/dialog")].ask (installed package)

const result = await ask(
  ctx, // the ExtensionContext of your tool/command
  {
    title: "Close issues", // label for memo-question / herdr:blocked (default: first question's title)
    audience: "user", // only the human may answer (see below)
    questions: [
      {
        id: "16",
        title: "Close #16?",
        context: ["federico-alunni/pi-issue-round", "abc1234 → main"], // fixed lines under the title
        body: "## Evidence\n- commit abc1234 on main", // markdown, scrolls when it does not fit
        options: [{ label: "Close (Recommended)", description: "the commit is on main" }, { label: "Leave open" }],
        initial: 0, // preselected option (0-based); with multiSelect a number[]
        freeAnswer: false, // no "Type something." (default true)
        notes: false, // no note with Tab (default true)
      },
    ],
    // Optional final page; a function gets the answers and may return null for no confirmation.
    review: (answers) => ({
      title: "Close the selected issues?",
      body: Object.entries(answers).map(([id, a]) => `- #${id}: ${a.labels[0]}`).join("\n"),
      options: [{ label: "Yes" }, { label: "No" }],
      initial: 1, // the safe "No" preselected
    }),
  },
  { signal, pi }, // signal: abort closes the dialog; pi: needed for the events
);
```

Result (never an exception):

```ts
| { status: "answered"; answers: Record<id, { indices: number[]; labels: string[]; custom?: string; note?: string }>;
    review?: { index: number; label: string } }   // review: the option chosen on the review page
| { status: "cancelled"; reason?: string }          // Esc, select cancelled, no UI ("no UI available…"), invalid request
| { status: "aborted" }                             // the signal aborted
```

`indices` are 0-based in option order (one for a single choice, the checked ones for `multiSelect`, empty for a
free answer only); `custom` is the free answer text.

### Keys

| Key | Effect |
|---|---|
| ↑ / ↓ | move between options; **on a page whose body does not fit, they scroll the body** |
| PgUp / PgDn, Home / End | scroll the body by a page, to its top / bottom |
| Shift+↑ / Shift+↓, 1–9 | move between options (always: the way to choose while ↑/↓ scroll) |
| ← / → | previous / next question (dialogs with several questions or a review) |
| Space | `multiSelect`: check / uncheck |
| Tab | note on the option (when `notes` is on) |
| Enter | answer and go to the next unanswered question (or the review, or close); `multiSelect`: confirm the checked options; on "Type something.": open the editor |
| Esc | in the note / free answer editor: back to the options; anywhere else: **cancel the whole dialog** |

The hint at the bottom of the dialog always shows the keys of the current page. At the top, dialogs with several
pages show where you are (`2/5  ✓1 [2] 3 4 5 Review`). Title, context and options stay fixed; only the body
scrolls. Everything fits in `tui.terminal.rows` (recomputed at every render, so resizing works): with too little
room the body shrinks to a window, then the options to a window around the cursor, then the layout drops borders
and blank lines. Lines are cut with `truncateToWidth` / `wrapTextWithAnsi` (ANSI, wide characters).

### Consent decisions

- `guardMs`: Enter is ignored for this long after the dialog opens and after the review page opens, so a key left
  in the buffer cannot approve. Default 600 ms (`DEFAULT_GUARD_MS`) when a question has `freeAnswer: false` or there
  is a review, otherwise 0. Esc still cancels.
- `audience: "user"`: only the human answers. Questions reach a parent agent (pi-memo-subagents' `askParent` /
  `to: "parent"`) only through the [router](#router-to-parent), which only the **`question` tool** consults: `ask()`
  never calls it, whatever the audience. Hosts that instead replace `ctx.ui.custom` to answer without the dialog
  (what pi-memo-subagents did before the router) are covered too: with `audience: "user"`, `ask()` accepts only
  results produced by its own dialog's key handling, so an answer returned by a replaced `ctx.ui.custom` (or a
  fabricated result object) gives `cancelled` with reason `…(audience: user)`. The factory passed to `ctx.ui.custom`
  carries `factory[Symbol.for("pi-memo-question.audience")]` (`ASK_AUDIENCE`) and the `memo-question` events carry
  `audience: "user"`, so a host can also tell. Tested in `test/ask.test.ts` ("audience user …"). The
  `ctx.ui.select` fallback cannot tell who answers: it is the RPC client's own dialog.
- Keep consequential decisions in your tool's code: call `ask()` inside the tool, never take an approval as a tool
  parameter.

### Without custom UI

When `ctx.ui.custom` cannot show the dialog (RPC: `ctx.mode !== "tui"` or `custom` returns `undefined`; `custom`
missing or throwing), `ask()` asks with one `ctx.ui.select` per question. It offers the same options in the same
order, with the `initial` option moved to the top; the text holds the title, context and body as plain text (never
JSON), and options show `label — description`. The free answer is offered as "Type something." when `ctx.ui.input`
exists. `multiSelect` becomes a loop: "Done (n selected)" first, then `[x]` / `[ ]` options to toggle. The review
becomes one more select. Without any UI (`!ctx.hasUI`), `ask()` returns `cancelled` with a reason.

### Also exported

`askComponent(tui, theme, request, done, { signal })` (the dialog component, for your own `ctx.ui.custom`),
`isDialogResult`, `guardMsOf`, `DEFAULT_GUARD_MS`, `FREE_ANSWER`, `ASK_AUDIENCE` and the types (`AskRequest`,
`Question`, `ReviewSpec`, `AskResult`, `Answers`, …). Options also take `id`, the id of the `memo-question` events
(default: a new UUID). The loaded extension publishes `ask` and `askComponent` next to `questionComponent` on
`globalThis[Symbol.for("pi-memo-question/dialog")]`, for hosts that use the installed package without importing it.

## Releasing (maintainers)

1. Bump `version` in `package.json`, commit, push to `main` (CI runs `npm test`).
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` checks that the tag is on `main` and equals `package.json` version, runs the
   tests and creates the GitHub Release. Nothing is built or published elsewhere: pi reads the source from git.

## Events

While a dialog (the tool's or `ask()`'s) is open, it emits on `pi.events` (see `src/events.ts`):

- `memo-question` — `{ id, question, pending: true }`, then `{ id, question, pending: false, answer }`
  (`answer`: chosen label or free text, several answers joined with ` | `, `null` if cancelled or aborted; `ask()`
  adds `audience: "user"` when set). pi-memo-subagents' child extension
  writes it to `question.json`, so the parent shows the pending question (❓) and Issue Round moves the focus to the
  pane.
- `herdr:blocked` — `{ active: true, label }` / `{ active: false }`, for the Herdr agent-state extension.

## Router (`to: "parent"`)

`question` takes an optional `to`: `"user"` (the human) or `"parent"` (the agent that started this one, when it can
know the answer; it may forward the question to the user). Without `to` the session's default applies.

A host answers parent questions by registering a router (see `src/router.ts`) on
`globalThis[Symbol.for("pi-memo-question/router")]` — `{ defaultTarget(), askParent(question, signal) }`. The key is a
registered symbol, so the host never imports this package: there is always exactly one `question` tool, the one of the
installed package. pi-memo-subagents registers it in its children (ask-parent). Without a router every question goes to
the user and `to: "parent"` says so in the result.

- Answered by the router: no dialog and no `memo-question`/`herdr:blocked` events (the router reports its own waiting
  state); the result reads `The parent agent selected: 2. Push` and `details.answeredBy` names who answered.
- `{ kind: "user", reason }`: the dialog opens as usual and the result says why the user answered.

The extension also publishes its dialog component on `globalThis[Symbol.for("pi-memo-question/dialog")]`
(`{ questionComponent, questionnaireComponent, ask, askComponent }`), for a host that shows a question itself (e.g. a
parent session escalating a subagent's question to the user) without importing a copy.

## Results

`User selected: 2. Push` (plus `\nUser note: …`), `User selected: 1. Lint, 3. Types` for multiple choice (plus
`\nUser also wrote: …`), `User wrote: …`, `User cancelled the selection`; no UI or no options return an error text
without opening the dialog. With several questions the results are joined, each under `[i/N] question`, and
`details.results` holds one entry per question asked.

## Tests

```bash
npm test
```

The tests need the pi host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`).
`test/host-aliases.mjs` finds them via `PI_HOST_DIR=<path of pi-coding-agent>`, then packages installed in
`node_modules` (what CI does); if neither is found it fails with an explicit message.
