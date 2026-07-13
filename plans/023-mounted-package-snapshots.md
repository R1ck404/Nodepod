# 023 — Mounted package snapshots

Status: IN PROGRESS

Mount cached package bytes as copy-on-write views, suppress per-entry watcher traffic, and synchronize a completed mount between workers as one bulk snapshot. Persist and coalesce registry metadata. Add dependency-graph persistence after resolver-version invalidation is defined.
