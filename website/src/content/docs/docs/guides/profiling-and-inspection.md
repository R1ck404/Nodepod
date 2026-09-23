---
title: Profiling and inspection
description: Diagnose Nodepod runtime performance and inspect attached previews.
sidebar:
  order: 7
---

## Profiling

Profiling is opt-in:

```ts
const pod = await Nodepod.boot({
  profiler: { enabled: true },
});
```

The profiler can collect subsystem timings, worker spans, memory samples, long-task samples, counters, and trace exports. Collection adds overhead, so enable only the detail required for a diagnosis and verify the exact options in the [generated API reference](/Nodepod/docs/reference/api/).

## Preview inspection

Nodepod's `inspect` API can query a preview that your application has explicitly attached. Depending on browser support and deployment policy, it can report viewport and document size, DOM/text summaries, overflow, console messages, errors, network failures, navigation state, accessibility summaries, interactive controls, and best-effort screenshots.

Inspection is an application debugging capability, not a cross-origin bypass. It relies on the Nodepod preview bridge and remains constrained by the browser's origin and messaging rules.
