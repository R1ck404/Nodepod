# 027 — OPFS package storage

Status: EXPERIMENTAL

Canary immutable package snapshots in OPFS behind `packageStore: "opfs"` with automatic IndexedDB fallback and corruption detection. Do not make `"auto"` select OPFS until worker sync-access handles, multi-pod locking, generations, compaction, quota recovery, and parity gates pass.
