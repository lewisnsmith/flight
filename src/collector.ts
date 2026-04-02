import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_LOG_DIR } from "./shared.js";
import type { LogEntry } from "./logger.js";

export interface CollectorOptions {
  port?: number;
  logDir?: string;
}

const DEFAULT_PORT = 4242;

function validateEntry(obj: unknown): obj is LogEntry {
  if (!obj || typeof obj !== "object") return false;
  const entry = obj as Record<string, unknown>;
  return (
    typeof entry.session_id === "string" &&
    typeof entry.timestamp === "string"
  );
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const MAX_BODY = 10 * 1024 * 1024; // 10MB
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export async function startCollector(options?: CollectorOptions): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const port = options?.port ?? DEFAULT_PORT;
  const logDir = options?.logDir ?? DEFAULT_LOG_DIR;

  await mkdir(logDir, { recursive: true });

  // Track open file handles per session for batching
  const sessionFiles = new Map<string, string>();

  function getSessionPath(sessionId: string): string {
    let path = sessionFiles.get(sessionId);
    if (!path) {
      path = join(logDir, `${sessionId}.jsonl`);
      sessionFiles.set(sessionId, path);
    }
    return path;
  }

  const server = createServer(async (req, res) => {
    // CORS headers for browser-based agents
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (req.method === "GET" && url.pathname === "/health") {
      let sessionCount = 0;
      try {
        const files = await readdir(logDir);
        sessionCount = files.filter((f) => f.endsWith(".jsonl")).length;
      } catch { /* ignore */ }
      sendJson(res, 200, { status: "ok", sessions: sessionCount });
      return;
    }

    if (req.method === "POST" && url.pathname === "/ingest") {
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        sendJson(res, 413, { error: "Body too large" });
        return;
      }

      const lines = body.split("\n").filter((l) => l.trim());
      let accepted = 0;
      let rejected = 0;
      const writesBySession = new Map<string, string[]>();

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (!validateEntry(parsed)) {
            rejected++;
            continue;
          }
          const sessionId = parsed.session_id;
          let sessionLines = writesBySession.get(sessionId);
          if (!sessionLines) {
            sessionLines = [];
            writesBySession.set(sessionId, sessionLines);
          }
          sessionLines.push(line);
          accepted++;
        } catch {
          rejected++;
        }
      }

      // Write batched entries per session
      const writePromises: Promise<void>[] = [];
      for (const [sessionId, sessionLines] of writesBySession) {
        const path = getSessionPath(sessionId);
        writePromises.push(
          appendFile(path, sessionLines.join("\n") + "\n").catch((err) => {
            process.stderr.write(`[flight] Write error for ${sessionId}: ${err instanceof Error ? err.message : err}\n`);
          }),
        );
      }
      await Promise.all(writePromises);

      sendJson(res, 200, { accepted, rejected });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, () => {
      resolve({
        server,
        port,
        async close() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      });
    });
  });
}
