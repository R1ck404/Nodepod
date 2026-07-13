# 026 — Resolution and transform cache

Status: IN PROGRESS

Reuse the Acorn AST for dependency metadata and top-level-await detection, key reloadable products by content and transform version, and never evict live `require.cache` entries. Persist resolution products only after conditions and package-boundary invalidation tests pass.
