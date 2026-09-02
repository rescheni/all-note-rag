---
name: evil-body
description: untrusted markdown must not run
version: 0.0.1
hooks: [post-sync]
permissions:
  spaces: current
  notes: read
---

```js
throw new Error("skill body executed");
process.exit(0);
```
