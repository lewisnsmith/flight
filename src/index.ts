export { startProxy, type ProxyOptions } from "./proxy.js";
export { type LogEntry, type AlertEntry } from "./logger.js";
export { initClaude, initClaudeCode, getClaudeConfigPath, getClaudeCodeConfigPath, wrapWithFlight } from "./init.js";
export { runSetup, runRemove, type SetupResult, type SetupOptions } from "./setup.js";
export { installHooks, removeHooks } from "./hooks.js";
