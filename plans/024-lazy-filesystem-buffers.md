# 024 — Lazy filesystem buffers

Status: IN PROGRESS

Reuse a sequence-numbered 256 KB–4 MB SAB per lazy client and allocate temporary buffers for larger reads. Follow with internal `statMany` and `readdirWithTypes` operations plus resolution-only metadata prefetching.
