# pi-memo-question

The `question` tool for [pi](https://pi.dev): one question to the user with options (recommended option first),
a description under each option, an optional note on an option (Tab) and a free answer ("Type something.").

It is the **only** question tool of the memo extensions:

| Who | How it gets the tool |
|---|---|
| main agent (`pi`) | `~/.pi/agent/settings.json` → `"packages": [..., "../../code/personal/pi-memo-question"]` |
| `pi-ir` | `-e ~/code/personal/pi-memo-question` |
| memo-subagents children (`subagent` tool, Issue Round agents) | the runtime adds `-e <this package>/extensions/question.ts`: always for profile children, with `question: true` for isolated ones. pi loads the same path once, so it never conflicts with the profile's copy |

memo-subagents depends on it (`"pi-memo-question": "file:../pi-memo-question"`).

## Events

While the dialog is open the tool emits on `pi.events` (see `src/events.ts`):

- `memo-question` — `{ id, question, pending: true }`, then `{ id, question, pending: false, answer }`
  (`answer`: chosen label or free text, `null` if cancelled or the turn was aborted). memo-subagents' child extension
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
