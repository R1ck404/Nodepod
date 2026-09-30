export type IpcSerialization = "json" | "advanced";

/** Match child_process IPC before the browser transport structured-clones it. */
export function serializeIpcMessage(message: unknown, mode: IpcSerialization): unknown {
  if (message === null || !["string", "number", "boolean", "object"].includes(typeof message)) {
    const error = new TypeError("The message argument must be a string, number, boolean, or object");
    (error as TypeError & { code: string }).code = "ERR_INVALID_ARG_TYPE";
    throw error;
  }
  // Advanced IPC already travels through structured clone. Worker-thread
  // messages always use that transport and do not pass through this helper.
  if (mode === "advanced") return message;
  return JSON.parse(JSON.stringify(message));
}
