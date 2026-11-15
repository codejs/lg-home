import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/** Accounts allowed to sign in, created with `npm run add_user`. */
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  // scrypt digest, see src/server/auth.ts - never store plaintext passwords.
  passwordHash: text("password_hash").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Active login sessions; the id is a SHA-256 hash of the cookie token. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("sessions_user_id_idx").on(table.userId)],
);

/** Key/value app settings, e.g. the stable ThinQ client ID. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Devices registered to the ThinQ account, refreshed from the device list API. */
export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(), // ThinQ deviceId
  type: text("type").notNull(), // e.g. DEVICE_WASHER
  alias: text("alias").notNull(),
  modelName: text("model_name"),
  reportable: integer("reportable", { mode: "boolean" }),
  raw: text("raw", { mode: "json" }).$type<Record<string, unknown>>(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

/** Timestamped status snapshots, for history and charts. */
export const deviceStates = sqliteTable("device_states", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deviceId: text("device_id")
    .notNull()
    .references(() => devices.id, { onDelete: "cascade" }),
  state: text("state", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
});

/** Push/event messages received from ThinQ (MQTT), and control commands sent. */
export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deviceId: text("device_id"),
  kind: text("kind").notNull(), // "push" | "event" | "control"
  payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
