# pi-memo-question

The `question` tool for [pi](https://pi.dev): one question to the user with options (recommended option first),
a description under each option, an optional note on an option (Tab) and a free answer ("Type something.").

It is the **only** question tool of the memo extensions:

| Who | How it gets the tool |
|---|---|
| main agent (`pi`) | `~/.pi/agent/settings.json` → `"packages": [..., "../../code/personal/pi-memo-question"]` |
| `pi-ir` | `-e ~/code/personal/pi-memo-question` |
| pi-memo-subagents children (`subagent` tool, Issue Round agents) | the runtime adds `-e <this package>/extensions/question.ts`: always for profile children, with `question: true` for isolated ones. pi loads the same path once, so it never conflicts with the profile's copy |

pi-memo-subagents depends on it (`"pi-memo-question": "file:../pi-memo-question"`).

## Install (collaborators)

```bash
pi install git:github.com/federico-alunni/pi-memo-question   # latest main
pi update --extensions                                       # pull new versions
```

Without a `@ref` pi follows `main`, so `pi update --extensions` picks up new commits. Pinning a release
(`…pi-memo-question@v0.2.0`) freezes that tag: `pi update` will not move it, re-run `pi install` with the new tag.

> **Warning — load it from one source only.** If you already load this package from a local path
> (`settings.json` → `"packages": ["../../code/personal/pi-memo-question"]`, `-e <path>`, or `file:../pi-memo-question`
> in pi-memo-subagents), do **not** also install the git source: pi identifies packages by repo URL or absolute path,
> so the same `question` tool would be loaded twice. Remove one of the two.

## Releasing (maintainers)

1. Bump `version` in `package.json`, commit, push to `main` (CI runs `npm test`).
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` checks that the tag is on `main` and equals `package.json` version, runs the
   tests and creates the GitHub Release. Nothing is built or published elsewhere: pi reads the source from git.

## Events

While the dialog is open the tool emits on `pi.events` (see `src/events.ts`):

- `memo-question` — `{ id, question, pending: true }`, then `{ id, question, pending: false, answer }`
  (`answer`: chosen label or free text, `null` if cancelled or the turn was aborted). pi-memo-subagents' child extension
  writes it to `question.json`, so the parent shows the pending question (❓) and Issue Round moves the focus to the
  pane.
- `herdr:blocked` — `{ active: true, label }` / `{ active: false }`, for the Herdr agent-state extension.

## Results

`User selected: 2. Push` (plus `\nUser note: …`), `User wrote: …`, `User cancelled the selection`; no UI or no
options return an error text without opening the dialog.

## Tests

```bash
npm test
```

The tests need the pi host packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, `typebox`).
`test/host-aliases.mjs` finds them via `PI_HOST_DIR=<path of pi-coding-agent>`, then packages installed in
`node_modules` (what CI does), then the Homebrew global install.
