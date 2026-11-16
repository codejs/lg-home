import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { ThinQClient, ThinQConfigError, type Region } from "./client.js";

export * from "./client.js";

const CLIENT_ID_KEY = "thinq.clientId";
const REGIONS: readonly Region[] = ["AIC", "EIC", "KIC"];

/**
 * ThinQ requires one stable client ID per client; creating many can get the
 * account blocked. Generate it once and keep it in the settings table.
 */
export function getOrCreateClientId(): string {
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, CLIENT_ID_KEY)).get();
  if (row) return row.value;
  const clientId = randomUUID();
  db.insert(schema.settings).values({ key: CLIENT_ID_KEY, value: clientId }).run();
  return clientId;
}

function regionFromEnv(env: NodeJS.ProcessEnv): Region | undefined {
  const value = env.THINQ_REGION?.trim().toUpperCase();
  if (!value) return undefined;
  if (!REGIONS.includes(value as Region)) {
    throw new ThinQConfigError(`THINQ_REGION must be one of ${REGIONS.join(", ")} (got "${value}")`);
  }
  return value as Region;
}

/**
 * Build a client from environment variables. Throws ThinQConfigError when the
 * token or country is missing, or THINQ_REGION is invalid.
 */
export function createThinQClientFromEnv(env: NodeJS.ProcessEnv = process.env): ThinQClient {
  const accessToken = env.THINQ_ACCESS_TOKEN?.trim();
  const countryCode = env.THINQ_COUNTRY_CODE?.trim();
  if (!accessToken || !countryCode) {
    throw new ThinQConfigError("THINQ_ACCESS_TOKEN and THINQ_COUNTRY_CODE must be set (see .env.example)");
  }
  return new ThinQClient({
    accessToken,
    countryCode,
    clientId: getOrCreateClientId(),
    region: regionFromEnv(env),
    baseUrl: env.THINQ_API_BASE_URL?.trim() || undefined,
    apiKey: env.THINQ_API_KEY?.trim() || undefined,
  });
}

let client: ThinQClient | undefined;

/** The shared ThinQ client, configured from the environment on first use. */
export function thinq(): ThinQClient {
  client ??= createThinQClientFromEnv();
  return client;
}
