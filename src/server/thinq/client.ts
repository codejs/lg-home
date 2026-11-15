/**
 * Minimal client for the LG ThinQ Connect REST API, talking HTTP directly
 * (no SDK). Only the calls this app needs are implemented.
 *
 * Every request carries:
 *   Authorization: Bearer <PAT>   Personal Access Token from the developer site
 *   x-country                     two-letter country code of the ThinQ account
 *   x-client-id                   stable per-installation id (never rotate it)
 *   x-message-id                  unique per request (22-char url-safe base64)
 *   x-api-key / x-service-phase   fixed values published by LG
 *
 * Responses are wrapped: `{ messageId, timestamp, response }` on success and
 * `{ messageId, timestamp, error: { code, message } }` on failure.
 */
import { randomUUID } from "node:crypto";

/** Public API key from the ThinQ Connect documentation (same for every client). */
export const DEFAULT_API_KEY = "v6GFvkweNo7DK7yD3ylIZ9w52aKBU0eJ7wLXkSR3";
const SERVICE_PHASE = "OP";
const DEFAULT_TIMEOUT_MS = 15_000;

/** ThinQ serves each country from one of three regional API servers. */
export type Region = "AIC" | "EIC" | "KIC";

// prettier-ignore
const REGION_COUNTRIES: Record<Region, readonly string[]> = {
  // Americas
  AIC: [
    "AG", "AR", "AW", "BB", "BO", "BR", "BS", "BZ", "CA", "CL", "CO", "CR", "CU", "DM", "DO", "EC", "GD", "GT",
    "GY", "HN", "HT", "JM", "KN", "KY", "LC", "MX", "NI", "PA", "PE", "PR", "PY", "SR", "SV", "TC", "TT", "US",
    "UY", "VC", "VE", "VG", "VI",
  ],
  // Europe, Middle East, Africa
  EIC: [
    "AD", "AE", "AF", "AL", "AM", "AO", "AT", "AZ", "BA", "BE", "BF", "BG", "BH", "BI", "BJ", "BW", "BY", "CD",
    "CF", "CG", "CH", "CI", "CM", "CV", "CY", "CZ", "DE", "DJ", "DK", "DZ", "EE", "EG", "ER", "ES", "ET", "FI",
    "FO", "FR", "GA", "GB", "GE", "GH", "GI", "GL", "GM", "GN", "GQ", "GR", "GW", "HR", "HU", "IE", "IL", "IQ",
    "IR", "IS", "IT", "JO", "KE", "KG", "KM", "KW", "KZ", "LB", "LI", "LR", "LS", "LT", "LU", "LV", "LY", "MA",
    "MC", "MD", "ME", "MG", "MK", "ML", "MR", "MT", "MU", "MW", "MZ", "NA", "NE", "NG", "NL", "NO", "OM", "PL",
    "PS", "PT", "QA", "RE", "RO", "RS", "RU", "RW", "SA", "SC", "SD", "SE", "SI", "SK", "SL", "SM", "SN", "SO",
    "SS", "ST", "SY", "SZ", "TD", "TG", "TJ", "TM", "TN", "TR", "TZ", "UA", "UG", "UZ", "VA", "XK", "YE", "ZA",
    "ZM", "ZW",
  ],
  // Asia-Pacific
  KIC: [
    "AU", "BD", "BN", "BT", "CN", "FJ", "HK", "ID", "IN", "JP", "KH", "KR", "LA", "LK", "MM", "MN", "MO", "MV",
    "MY", "NC", "NP", "NZ", "PF", "PG", "PH", "PK", "SB", "SG", "TH", "TL", "TO", "TW", "VN", "VU", "WS",
  ],
};

export function regionForCountry(countryCode: string): Region {
  const country = countryCode.trim().toUpperCase();
  for (const [region, countries] of Object.entries(REGION_COUNTRIES) as [Region, readonly string[]][]) {
    if (countries.includes(country)) return region;
  }
  throw new ThinQConfigError(
    `Unknown ThinQ country code "${countryCode}". Set THINQ_REGION (AIC, EIC or KIC) to pick the API server.`,
  );
}

export function baseUrlForRegion(region: Region): string {
  return `https://api-${region.toLowerCase()}.lgthinq.com`;
}

/** Missing or invalid configuration (token, country, region). */
export class ThinQConfigError extends Error {
  override name = "ThinQConfigError";
}

/** A failed ThinQ call: an error response, a timeout or a network failure. */
export class ThinQError extends Error {
  override name = "ThinQError";
  constructor(
    message: string,
    /** "response": ThinQ answered with an error; otherwise it never answered. */
    readonly reason: "response" | "timeout" | "network",
    /** Upstream HTTP status, null when there was no response. */
    readonly status: number | null = null,
    /** ThinQ error code from the response body, e.g. "1222". */
    readonly code: string | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** One entry of `GET /devices`. */
export interface ThinQDevice {
  deviceId: string;
  deviceInfo: {
    deviceType: string;
    modelName?: string;
    alias?: string;
    reportable?: boolean;
    [key: string]: unknown;
  };
}

export type JsonObject = Record<string, unknown>;

export interface ThinQClientOptions {
  accessToken: string;
  countryCode: string;
  clientId: string;
  /** Defaults to the regional server for the country. */
  baseUrl?: string;
  region?: Region;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
}

export class ThinQClient {
  readonly baseUrl: string;
  private readonly accessToken: string;
  private readonly countryCode: string;
  private readonly clientId: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ThinQClientOptions) {
    if (!options.accessToken) throw new ThinQConfigError("A ThinQ Personal Access Token is required");
    if (!options.clientId) throw new ThinQConfigError("A ThinQ client id is required");
    this.accessToken = options.accessToken;
    this.countryCode = options.countryCode.trim().toUpperCase();
    this.clientId = options.clientId;
    this.apiKey = options.apiKey ?? DEFAULT_API_KEY;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;
    const base = options.baseUrl ?? baseUrlForRegion(options.region ?? regionForCountry(this.countryCode));
    this.baseUrl = base.replace(/\/+$/, "");
  }

  /** Devices registered to the account. */
  async getDevices(): Promise<ThinQDevice[]> {
    return (await this.request<ThinQDevice[] | undefined>("GET", "/devices")) ?? [];
  }

  /** Which resources/properties a device has and which are writable. */
  async getDeviceProfile(deviceId: string): Promise<JsonObject> {
    return (await this.request<JsonObject | undefined>("GET", `/devices/${encodeURIComponent(deviceId)}/profile`)) ?? {};
  }

  /** Current state of a device. */
  async getDeviceStatus(deviceId: string): Promise<JsonObject> {
    return (await this.request<JsonObject | undefined>("GET", `/devices/${encodeURIComponent(deviceId)}/state`)) ?? {};
  }

  /**
   * Send a control command, e.g. `{ "operation": { "airConOperationMode": "POWER_ON" } }`.
   * `x-conditional-control` makes ThinQ reject commands the device can't take
   * in its current state instead of queueing them.
   */
  async controlDevice(deviceId: string, command: JsonObject): Promise<JsonObject> {
    const result = await this.request<JsonObject | undefined>(
      "POST",
      `/devices/${encodeURIComponent(deviceId)}/control`,
      { body: command, headers: { "x-conditional-control": "true" } },
    );
    return result ?? {};
  }

  /** Low-level call: returns the unwrapped `response` field or throws ThinQError. */
  async request<T = unknown>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "x-country": this.countryCode,
      "x-message-id": newMessageId(),
      "x-client-id": this.clientId,
      "x-api-key": this.apiKey,
      "x-service-phase": SERVICE_PHASE,
      Accept: "application/json",
      ...options.headers,
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new ThinQError(`ThinQ API did not respond within ${this.timeoutMs} ms`, "timeout", null, null, {
          cause: err,
        });
      }
      throw new ThinQError(`Could not reach the ThinQ API: ${describe(err)}`, "network", null, null, { cause: err });
    }

    const text = await res.text();
    let payload: { response?: unknown; error?: { code?: unknown; message?: unknown } } | null = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!res.ok) {
      const code = payload?.error?.code != null ? String(payload.error.code) : null;
      const detail = typeof payload?.error?.message === "string" ? payload.error.message : res.statusText;
      const message = `ThinQ API error ${res.status}${code ? ` (code ${code})` : ""}${detail ? `: ${detail}` : ""}`;
      throw new ThinQError(message, "response", res.status, code);
    }
    if (text && payload === null) {
      throw new ThinQError("ThinQ API returned a response that is not JSON", "response", res.status);
    }
    return payload?.response as T;
  }
}

/** 16 random bytes as url-safe base64 without padding (22 chars), as ThinQ expects. */
export function newMessageId(): string {
  return Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64url");
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return `${err.message}${cause}`;
  }
  return String(err);
}
