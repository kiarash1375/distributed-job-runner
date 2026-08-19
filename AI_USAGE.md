# AI Usage

## Tool

Claude (Opus 5), used through the chat interface for the entire project.
No other AI tool, code assistant, or autocomplete was used.

## How it was used

I had no prior experience with TypeScript, Node.js, Docker, or distributed
systems before starting this task. The working method was deliberately
constrained: for each step, the architecture and reasoning were explained first,
I confirmed I understood it, and only then was code written. Code I could not
explain was not accepted into the project.

Specifically, AI was used for:

- **Architecture discussion.** Why agents dial out rather than being dialled,
  why the database is the source of truth and the WebSocket only transport, why
  the gateway and agent are separate processes, whether a message broker was
  needed (concluded: not at this scale, and its absence is justified in
  docs/NOTES.md).
- **Writing the implementation code**, with each file explained line by line
  before being added.
- **Debugging.** Environment setup problems (WSL2, Docker credential helper,
  DNS), and the three behavioural bugs recorded in docs/NOTES.md.
- **Documentation drafting**, from notes I recorded during development.

## What was mine

- Running and observing the system, and deciding what to test.
- Finding the bugs. Each of the three recorded in docs/NOTES.md was found by
  running the system and noticing the result was wrong — a job whose output
  never appeared, a job reported as successful that never ran, a job marked
  failed that never started. In each case I raised the discrepancy first.
- Scope decisions: what to build, what to leave as a documented gap, when to
  stop optimising.
- Verifying every claim in the documentation against an actual run.

## Honest limitations

The project was built in roughly three days by someone new to this stack, so my
depth is uneven. I understand the architecture, the state machine, the delivery
guarantees, and the reasoning behind each trade-off, and I can defend those. I
am less fluent in TypeScript and Node idioms than in the design itself, and
parts of the code follow patterns I was shown rather than patterns I would have
reached for independently.

The known gaps in docs/NOTES.md are gaps I understand and chose not to close in
the time available, not gaps I discovered afterwards.