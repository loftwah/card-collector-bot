/**
 * Stateful double for the Discord interaction webhook contract.
 *
 * It intentionally models the documented behaviours the production handler
 * depends on, rather than agreeing with the old implementation:
 *
 * - a deferred acknowledgement fixes the original message visibility;
 * - editing the original preserves that visibility;
 * - the first POST to the interaction webhook while the original is still
 *   loading edits the original (the deprecated compatibility path), so a
 *   public follow-up requires the original to be settled first;
 * - later POSTs create a follow-up with visibility from the EPHEMERAL flag;
 * - interaction tokens expire after 15 minutes and messages have stable IDs.
 */

export const EPHEMERAL_FLAG = 64;

export interface TransportMessage {
  id: string;
  token: string;
  visibility: "public" | "ephemeral";
  loading: boolean;
  payload: Record<string, unknown>;
  files: number;
  edits: number;
  createdAt: number;
}

export interface TransportFailure {
  method: string;
  /** "original" | "followup" | "any" */
  target: "original" | "followup" | "any";
  status: number;
  body?: string;
  times?: number;
}

interface OriginalRecord {
  token: string;
  message: TransportMessage;
}

export class DiscordTransport {
  readonly messages: TransportMessage[] = [];
  readonly requests: Array<{ method: string; target: string; visibility?: string }> = [];
  readonly failures: TransportFailure[] = [];
  private readonly originals = new Map<string, OriginalRecord>();
  private sequence = 0;
  now = Date.now();
  tokenTtlMs = 15 * 60_000;

  acknowledge(token: string, flags: number | undefined): TransportMessage {
    const visibility = (flags ?? 0) & EPHEMERAL_FLAG ? "ephemeral" : "public";
    const message: TransportMessage = {
      id: `msg_original_${++this.sequence}`,
      token,
      visibility,
      loading: true,
      payload: {},
      files: 0,
      edits: 0,
      createdAt: this.now,
    };
    this.messages.push(message);
    this.originals.set(token, { token, message });
    return message;
  }

  failNext(failure: TransportFailure): void {
    this.failures.push({ ...failure, times: failure.times ?? 1 });
  }

  private takeFailure(method: string, target: "original" | "followup"): TransportFailure | null {
    const index = this.failures.findIndex(
      (failure) =>
        failure.method === method &&
        (failure.target === "any" || failure.target === target) &&
        (failure.times ?? 1) > 0,
    );
    if (index < 0) return null;
    const failure = this.failures[index]!;
    failure.times = (failure.times ?? 1) - 1;
    if ((failure.times ?? 0) <= 0) this.failures.splice(index, 1);
    return failure;
  }

  original(token: string): TransportMessage | undefined {
    return this.originals.get(token)?.message;
  }

  publicMessages(): TransportMessage[] {
    return this.messages.filter((message) => message.visibility === "public");
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = String(init?.method ?? "GET").toUpperCase();
    const parts = url.pathname.split("/").filter(Boolean);
    const token = parts[4];
    const isOriginal = parts[5] === "messages" && parts[6] === "@original";
    const isMessage = parts[5] === "messages" && parts[6] && parts[6] !== "@original";
    const target = isOriginal || isMessage ? "original" : "followup";
    this.requests.push({ method, target });

    if (!token || url.hostname !== "discord.com") {
      return new Response("not found", { status: 404 });
    }
    const original = this.originals.get(token);
    if (!original) return new Response("unknown interaction", { status: 404 });
    if (this.now - original.message.createdAt > this.tokenTtlMs) {
      return new Response("interaction token expired", { status: 401 });
    }
    const failure = this.takeFailure(method, target);
    if (failure) {
      return new Response(failure.body ?? "simulated provider failure", { status: failure.status });
    }

    if (isOriginal && method === "PATCH") {
      original.message.payload = await this.readPayload(init);
      original.message.files = this.countFiles(init);
      original.message.loading = false;
      original.message.edits += 1;
      return this.json(original.message);
    }
    if (isOriginal && method === "GET") {
      return this.json(original.message);
    }
    if (isOriginal && method === "DELETE") {
      original.message.loading = false;
      return new Response(null, { status: 204 });
    }
    if (!isOriginal && !isMessage && method === "POST") {
      if (original.message.loading) {
        // Documented backwards-compatibility path: this edits the original and
        // the EPHEMERAL flag cannot change the existing visibility.
        original.message.payload = await this.readPayload(init);
        original.message.files = this.countFiles(init);
        original.message.loading = false;
        original.message.edits += 1;
        return this.json(original.message);
      }
      const payload = await this.readPayload(init);
      const flags = Number(payload.flags ?? 0);
      const message: TransportMessage = {
        id: `msg_followup_${++this.sequence}`,
        token,
        visibility: flags & EPHEMERAL_FLAG ? "ephemeral" : "public",
        loading: false,
        payload,
        files: this.countFiles(init),
        edits: 0,
        createdAt: this.now,
      };
      this.messages.push(message);
      return this.json(message);
    }
    if (isMessage && method === "PATCH") {
      const id = parts[6];
      const message = this.messages.find((candidate) => candidate.id === id);
      if (!message) return new Response("unknown message", { status: 404 });
      message.payload = await this.readPayload(init);
      message.files = this.countFiles(init);
      message.edits += 1;
      return this.json(message);
    }
    return new Response("unsupported route", { status: 404 });
  };

  private json(message: TransportMessage): Response {
    return new Response(JSON.stringify({ id: message.id }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  private async readPayload(init?: RequestInit): Promise<Record<string, unknown>> {
    const body = init?.body;
    if (body instanceof FormData) {
      const raw = String(body.get("payload_json") ?? "{}");
      return JSON.parse(raw) as Record<string, unknown>;
    }
    return JSON.parse(String(body ?? "{}")) as Record<string, unknown>;
  }

  private countFiles(init?: RequestInit): number {
    if (!(init?.body instanceof FormData)) return 0;
    let count = 0;
    while (init.body.has(`files[${count}]`)) count += 1;
    return count;
  }
}
