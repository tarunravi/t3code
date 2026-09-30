# Context in portable handoffs

T3 Code transfers conversation context when you switch providers, continue through a portable
restart, or use a fork that the provider cannot resume itself.

Short conversations transfer intact. For longer conversations, T3 Code favors recent requests and
answers, the original request, and relevant activity such as command outcomes. Selected messages
keep their full text, order, and user or assistant role, including partial work from failed or
interrupted turns. Your new request stays separate and is never shortened to make history fit.

Codex receives historical messages directly when its installed version supports that operation.
Other providers receive the same selection as attributed conversation context. A handoff does not
copy the outgoing provider's reasoning, tool-call state, or attachments.

The handoff includes references to omitted history. The agent can use T3 Code's thread-reading tool
to retrieve saved messages and activity, including the remainder of a long item. For an important
constraint, you can still repeat it in your next message. A handoff is a budgeted selection, not an
agent-written summary.

## Context limits

A handoff must leave room for existing provider context, your request and attachments, instructions,
tools, and subsequent work. T3 Code sizes the imported transcript to the selected model's known
context window, leaving 16,000 tokens for tools and later work when that much is free. Messages that
still do not fit are omitted whole. If a short transcript does not fit, the handoff can point the
agent to saved history through `t3_thread_read` instead.

If the target conversation has no room for the request and handoff, T3 Code starts a fresh provider
conversation with bounded saved history and sends your request automatically. If the request and
attachments leave too little room even there, shorten the request or select a larger-context model.
T3 Code never shortens your request to make it fit.

Recovery leaves running background work intact. Let it finish or stop it before retrying the handoff.

Server operators can set `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` to change the initial history allowance
(default 16,000; clamped to 1,024–64,000). This is an upper bound, not a provider context-window
guarantee. Text accounting conservatively charges one token per UTF-8 byte, including attribution
and JSON escaping. Imported history has a separate 64,000-byte ceiling; your current input and
attachment payloads do not consume that ceiling.

T3 Code uses available capacity information for your selected model and options, together with
provider context telemetry. Starting a fresh provider conversation clears prior usage, while keeping
known model capacity. Changing models or context-window options discards stale usage and compaction
thresholds.

When no capacity information is available, T3 Code assumes a 128,000-token window. It reserves
16,000 tokens for instructions, tools, and subsequent work when the window still has that much free.
Images reserve an estimated 8,192 tokens each, independent of their file size; other
attachments reserve 4,096 each for their references.
Existing context is estimated from saved activity when usage telemetry is unavailable. A byte-length
estimate can overstate the transcript; it may shrink the handoff, but it cannot remove the recovery
pointer when your request fits the known window. Known smaller windows still constrain the handoff.
These are fallback estimates, not exact token counts. Image resolution, custom models, and hidden
native context can differ, so the provider may still reject an input.
