import { db, resetDb, schema } from "../../helpers/test-db.js";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { ThinQConfigError, createThinQClientFromEnv, getOrCreateClientId } from "../../../src/server/thinq/index.js";

const base = { THINQ_ACCESS_TOKEN: "pat", THINQ_COUNTRY_CODE: "US" };

describe("createThinQClientFromEnv", () => {
  beforeEach(resetDb);

  it("builds a client for the country's region", () => {
    assert.equal(createThinQClientFromEnv(base).baseUrl, "https://api-aic.lgthinq.com");
    assert.equal(createThinQClientFromEnv({ ...base, THINQ_COUNTRY_CODE: "de" }).baseUrl, "https://api-eic.lgthinq.com");
    assert.equal(createThinQClientFromEnv({ ...base, THINQ_COUNTRY_CODE: " KR " }).baseUrl, "https://api-kic.lgthinq.com");
  });

  for (const [name, env] of [
    ["no token", { THINQ_COUNTRY_CODE: "US" }],
    ["blank token", { ...base, THINQ_ACCESS_TOKEN: "   " }],
    ["no country", { THINQ_ACCESS_TOKEN: "pat" }],
    ["blank country", { ...base, THINQ_COUNTRY_CODE: "" }],
  ] as const) {
    it(`requires configuration: ${name}`, () => {
      assert.throws(() => createThinQClientFromEnv(env), ThinQConfigError);
    });
  }

  it("rejects an unknown country unless THINQ_REGION is set", () => {
    assert.throws(() => createThinQClientFromEnv({ ...base, THINQ_COUNTRY_CODE: "ZZ" }), /THINQ_REGION/);
    const client = createThinQClientFromEnv({ ...base, THINQ_COUNTRY_CODE: "ZZ", THINQ_REGION: "eic" });
    assert.equal(client.baseUrl, "https://api-eic.lgthinq.com");
  });

  it("rejects an invalid THINQ_REGION", () => {
    assert.throws(() => createThinQClientFromEnv({ ...base, THINQ_REGION: "MARS" }), /AIC, EIC, KIC/);
  });

  it("honours THINQ_API_BASE_URL and ignores it when blank", () => {
    assert.equal(createThinQClientFromEnv({ ...base, THINQ_API_BASE_URL: "http://127.0.0.1:8090/" }).baseUrl, "http://127.0.0.1:8090");
    assert.equal(createThinQClientFromEnv({ ...base, THINQ_API_BASE_URL: "  " }).baseUrl, "https://api-aic.lgthinq.com");
  });

  it("does not touch the database when configuration is missing", () => {
    assert.throws(() => createThinQClientFromEnv({}));
    assert.equal(db.select().from(schema.settings).all().length, 0);
  });
});

describe("getOrCreateClientId", () => {
  beforeEach(resetDb);

  it("generates a UUID once and then keeps returning it", () => {
    const first = getOrCreateClientId();
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(getOrCreateClientId(), first);
    assert.equal(db.select().from(schema.settings).all().length, 1);
  });

  it("reuses an existing stored id (ThinQ may block accounts that churn client ids)", () => {
    db.insert(schema.settings).values({ key: "thinq.clientId", value: "existing-id" }).run();
    assert.equal(getOrCreateClientId(), "existing-id");
  });
});
