// Assembles all builtin commands from category modules into one map.

import type { BuiltinFn } from "./shell-types.js";
import { fileOpsCommands } from "./commands/file-ops.js";
import { directoryCommands } from "./commands/directory.js";
import { textProcessingCommands } from "./commands/text-processing.js";
import { searchCommands } from "./commands/search.js";
import { shellEnvCommands, setBuiltinsRef } from "./commands/shell-env.js";
import { bashBuiltinCommands } from "./commands/bash-builtins.js";
import { systemCommands } from "./commands/system.js";

export const builtins = new Map<string, BuiltinFn>([
  ...fileOpsCommands,
  ...directoryCommands,
  ...textProcessingCommands,
  ...searchCommands,
  ...shellEnvCommands,
  ...bashBuiltinCommands,
  ...systemCommands,
]);

// shell-env needs the builtins ref for `which` and `type`
setBuiltinsRef(builtins);
