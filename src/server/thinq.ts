import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ThinQApi, type ThinQApiResponse } from "thinqconnect";
import { db, schema } from "./db/index.js";

const CLIENT_ID_KEY = "thinq.clientId";

/**
 * ThinQ requires one stable client ID per client; creating many can get the
 * account blocked. Generate it once and keep it in the settings table.
 */
function getOrCreateClientId(): string {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, CLIENT_ID_KEY)).get();
  if (row) return row.value;
  const clientId = randomUUID();
  db.insert(schema.settings).values({ key: CLIENT_ID_KEY, value: clientId }).run();
  return clientId;
}

export class ThinQError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string | null,
  ) {
    super(message ?? `ThinQ API error ${status}`);
  }
}

/** Return the body of a successful response, or throw a ThinQError. */
export function unwrap<T = unknown>(res: ThinQApiResponse): T {
  if (res.status >= 200 && res.status < 300) return res.body as T;
  throw new ThinQError(res.status, res.errorCode, res.errorMessage);
}

let api: ThinQApi | undefined;

export function thinq(): ThinQApi {
  if (api) return api;
  const token = process.env.THINQ_ACCESS_TOKEN;
  const country = process.env.THINQ_COUNTRY_CODE;
  if (!token || !country) {
    throw new Error("THINQ_ACCESS_TOKEN and THINQ_COUNTRY_CODE must be set (see .env.example)");
  }
  api = new ThinQApi(token, country, getOrCreateClientId());
  return api;
}
