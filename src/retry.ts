import type { JsonRpcMessage } from "./json-rpc.js";

// Read-only tool names safe to auto-retry on error
const SAFE_RETRY_NAMES = new Set([
  "read_file", "read", "get_file_contents",
  "list_dir", "list_directory", "ls",
  "search", "grep", "find_files",
]);

const SAFE_RETRY_PREFIXES = ["get_"];

// Permanent error codes that should never be retried
const PERMANENT_ERROR_CODES = new Set([-32601, -32602, -32600]);

function isReadOnlyTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  if (SAFE_RETRY_NAMES.has(toolName)) return true;
  return SAFE_RETRY_PREFIXES.some((p) => toolName.startsWith(p));
}

function isPermanentError(msg: JsonRpcMessage): boolean {
  if (!msg.error) return false;
  return PERMANENT_ERROR_CODES.has(msg.error.code);
}

export function getToolNameFromRequest(msg: JsonRpcMessage): string | undefined {
  if (msg.method === "tools/call" && msg.params && typeof msg.params === "object") {
    return (msg.params as Record<string, unknown>).name as string | undefined;
  }
  return undefined;
}

export interface RetryResult {
  /** Whether the retry manager handled this message (caller should not process further) */
  handled: boolean;
  /** Message to forward to the client, if any */
  forward?: JsonRpcMessage;
}

export interface RetryManager {
  /** Track an outgoing client request for potential retry */
  trackRequest(msg: JsonRpcMessage): void;
  /** Get the original client request for a given response id */
  getOriginalRequest(id: string | number): JsonRpcMessage | undefined;
  /** Remove a tracked request */
  clearRequest(id: string | number): void;
  /**
   * Process an upstream response through retry logic.
   * Returns { handled: true } if the message was consumed by retry (pending retry response or scheduled for retry).
   * The caller should check handled and skip normal processing if true.
   * sendRetry is called when a retry needs to be sent upstream after a delay.
   */
  handleResponse(msg: JsonRpcMessage, sendRetry: (req: JsonRpcMessage) => void): RetryResult;
  /**
   * Drain all pending state on upstream exit.
   * Returns held retry errors to forward and orphaned request ids to send error responses for.
   */
  drain(): { heldErrors: JsonRpcMessage[]; orphanedIds: (string | number)[] };
}

export function createRetryManager(enabled: boolean): RetryManager {
  const pendingRequests = new Map<string | number, JsonRpcMessage>();
  const pendingRetries = new Map<string | number, JsonRpcMessage>();

  return {
    trackRequest(msg: JsonRpcMessage) {
      if (enabled && msg.id != null) {
        pendingRequests.set(msg.id, msg);
      }
    },

    getOriginalRequest(id: string | number) {
      return pendingRequests.get(id);
    },

    clearRequest(id: string | number) {
      pendingRequests.delete(id);
    },

    handleResponse(msg: JsonRpcMessage, sendRetry: (req: JsonRpcMessage) => void): RetryResult {
      if (msg.id == null) return { handled: false };

      // Check if this is a response to a pending retry
      if (pendingRetries.has(msg.id)) {
        const heldError = pendingRetries.get(msg.id)!;
        pendingRetries.delete(msg.id);

        if (msg.error) {
          // Retry also failed — forward original error
          return { handled: true, forward: heldError };
        }
        // Retry succeeded — forward success
        return { handled: true, forward: msg };
      }

      // Check if we should auto-retry this failed response
      if (enabled && msg.error && !isPermanentError(msg)) {
        const originalRequest = pendingRequests.get(msg.id);
        if (originalRequest) {
          const toolName = getToolNameFromRequest(originalRequest);
          if (originalRequest.method === "tools/call" && isReadOnlyTool(toolName)) {
            pendingRequests.delete(msg.id);
            pendingRetries.set(msg.id, msg);

            // Schedule retry after 500ms
            setTimeout(() => {
              sendRetry(originalRequest);
            }, 500);

            return { handled: true };
          }
        }
      }

      return { handled: false };
    },

    drain() {
      const heldErrors = Array.from(pendingRetries.values());
      pendingRetries.clear();

      const orphanedIds = Array.from(pendingRequests.keys());
      pendingRequests.clear();

      return { heldErrors, orphanedIds };
    },
  };
}
