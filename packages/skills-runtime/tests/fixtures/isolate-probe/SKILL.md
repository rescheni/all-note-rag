---
name: isolate-probe
description: test spawn / timeout / env
version: 0.0.1
hooks: [post-sync, weekly-report]
permissions:
  spaces: current
  notes: read
---

Probe skill used by isolation tests. Body must never be evaluated.
