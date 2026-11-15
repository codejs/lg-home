import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface MockReply {
  status?: number;
  /** Sent as JSON unless it is a string. */
  body?: unknown;
  /** Wait this long before answering (for timeout tests). */
  delayMs?: number;
}

export type MockHandler = (req: RecordedRequest) => MockReply;

/**
 * A stand-in for the ThinQ Connect API: records every request and answers via
 * `handler`, wrapping plain results in ThinQ's `{ messageId, timestamp, response }`.
 */
export class MockThinQ {
  readonly requests: RecordedRequest[] = [];
  handler: MockHandler = () => ({ status: 404, body: { error: { code: "1000", message: "no handler" } } });
  private server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const recorded: RecordedRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      this.requests.push(recorded);
      const reply = this.handler(recorded);
      const send = () => {
        const payload = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
        res.writeHead(reply.status ?? 200, {
          "Content-Type": typeof reply.body === "string" ? "text/html" : "application/json",
        });
        res.end(payload);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });

  get url(): string {
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  start(): Promise<void> {
    return new Promise((resolve) => this.server.listen(0, "127.0.0.1", () => resolve()));
  }

  stop(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}

/** ThinQ's success envelope. */
export function ok(response: unknown): MockReply {
  return { status: 200, body: { messageId: "test", timestamp: new Date().toISOString(), response } };
}

/** ThinQ's error envelope. */
export function fail(status: number, code: string, message: string): MockReply {
  return { status, body: { messageId: "test", timestamp: new Date().toISOString(), error: { code, message } } };
}
