import { randomUUID } from "node:crypto";
import { createSessionLogger, type ModelConfig, type EventType, type LogEntry } from "./logger.js";
import type { JsonRpcMessage } from "./json-rpc.js";

export interface FlightClientOptions {
  sessionId?: string;
  runId?: string;
  agentId?: string;
  modelConfig?: ModelConfig;
  logDir?: string;
}

export interface FlightClient {
  logToolCall(toolName: string, input: unknown, output?: unknown, error?: string): void;
  logAction(action: string, outcome?: string, metadata?: Record<string, unknown>): void;
  logEvaluation(score: number, labels?: Record<string, string>, metadata?: Record<string, unknown>): void;
  logEvent(eventType: EventType, fields: Partial<LogEntry>): void;
  close(): Promise<void>;
  closeSync(): void;
  readonly sessionId: string;
}

export async function createFlightClient(options?: FlightClientOptions): Promise<FlightClient> {
  const logger = await createSessionLogger({
    logDir: options?.logDir,
    runId: options?.runId,
    agentId: options?.agentId,
    modelConfig: options?.modelConfig,
    sessionId: options?.sessionId,
  });

  const client: FlightClient = {
    get sessionId() {
      return logger.sessionId;
    },

    logToolCall(toolName: string, input: unknown, output?: unknown, error?: string) {
      // Log the request
      const callId = randomUUID();
      const requestMsg: JsonRpcMessage = {
        jsonrpc: "2.0",
        id: callId,
        method: "tools/call",
        params: { name: toolName, arguments: input },
      };
      logger.log(requestMsg, "client->server", { pd_active: false });

      // Log the response
      const responseMsg: JsonRpcMessage = {
        jsonrpc: "2.0",
        id: callId,
        ...(error
          ? { error: { code: -1, message: error } }
          : { result: output ?? null }),
      };
      logger.log(responseMsg, "server->client", { pd_active: false });
    },

    logAction(action: string, outcome?: string, metadata?: Record<string, unknown>) {
      const msg: JsonRpcMessage = {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "agent/action",
        params: {
          action,
          outcome: outcome ?? "unknown",
          ...(metadata && { metadata }),
        },
      };
      logger.log(msg, "client->server", { pd_active: false });
    },

    logEvaluation(score: number, labels?: Record<string, string>, metadata?: Record<string, unknown>) {
      const msg: JsonRpcMessage = {
        jsonrpc: "2.0",
        id: randomUUID(),
        method: "agent/evaluation",
        params: {
          score,
          ...(labels && { labels }),
          ...(metadata && { metadata }),
        },
      };
      logger.log(msg, "client->server", { pd_active: false });
    },

    logEvent(eventType: EventType, fields: Partial<LogEntry>) {
      const msg: JsonRpcMessage = {
        jsonrpc: "2.0",
        id: fields.call_id ?? randomUUID(),
        method: fields.method ?? eventType,
        params: fields.payload ?? {},
      };
      logger.log(msg, fields.direction ?? "client->server", { pd_active: false });
    },

    async close() {
      await logger.close();
    },

    closeSync() {
      logger.closeSync();
    },
  };

  return client;
}
