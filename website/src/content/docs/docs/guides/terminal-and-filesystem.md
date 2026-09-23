---
title: Terminal and filesystem
description: Attach xterm.js and work with Nodepod's virtual filesystem.
sidebar:
  order: 1
---

## Interactive terminal

Nodepod accepts xterm.js constructors, keeping terminal rendering out of the core package:

```ts
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const terminal = nodepod.createTerminal({ Terminal, FitAddon });
terminal.attach(document.querySelector('#terminal'));
```

Use `terminal.input('ls\r')` for explicit command shortcuts. Call `terminal.detach()` before removing its DOM container. The owning Nodepod instance is still responsible for process and worker cleanup through `teardown()`.

## Filesystem

```ts
await nodepod.fs.mkdir('/home/project/src', { recursive: true });
await nodepod.fs.writeFile('/home/project/src/index.js', 'console.log("ok")');

const source = await nodepod.fs.readFile('/home/project/src/index.js', 'utf8');
const entries = await nodepod.fs.readdir('/home/project/src');
const stat = await nodepod.fs.stat('/home/project/src/index.js');
```

Paths are POSIX-style. Each Nodepod instance owns an ephemeral filesystem unless you boot it with [workspace persistence](/Nodepod/docs/guides/persistence/) or explicitly create and store a snapshot. Treat browser storage as untrusted local state, not as your application's source of truth.
