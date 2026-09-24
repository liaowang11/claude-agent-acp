# Fork titles

A client can name a forked session through `_meta` on `session/fork`. Both keys are
optional, independent, and ignored by anything that does not send them. No capability
negotiation is required.

```json
{
  "_meta": {
    "sessionTitle": "Why does toggling open the compose buffer?",
    "generateSessionTitle": true
  }
}
```

Left alone, the Agent SDK titles every fork `<parent title> (fork)` and writes that into
the same stored field a `/rename` uses. The title therefore names the conversation the
fork came from, and because the field is non-empty from birth, the adapter's own title
generation (see `src/session-titles.ts`) latches onto it and never runs. A fork keeps its
parent's title for its whole life.

## `sessionTitle`

A string, used as the fork's title instead of the derived `<parent title> (fork)`.
Whitespace is collapsed and the result capped at 256 characters; a blank or non-string
value is ignored. It is written to the session file at fork time, so it reaches
`session/list`, `session/load` and the CLI's own session list.

## `generateSessionTitle`

`true` asks the adapter to title the fork after its own turns. The title the fork is born
with — supplied or derived — is remembered as inherited, and the first turn-end generates
over it rather than adopting it, exactly as a new session is titled. Once a title of the
fork's own lands, the inherited one is forgotten.

A `/rename` between the fork and that first turn-end is adopted as usual: only the exact
inherited string is titled over.

When title generation is unavailable — an older CLI — the inherited title stands. The
adapter does not fall back to the stored `summary` for a fork, since for a fork that is
the parent's first prompt.

Sending `sessionTitle` alone gives the fork a title immediately and permanently. Sending
both gives it a meaningful title straight away and a generated one after its first turn.
