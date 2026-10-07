import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

// All appointment times are stored as shop-local wall-clock strings
// ("YYYY-MM-DD HH:MM") so they sort lexically and never shift with DST.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Mexico_City',
  currency TEXT NOT NULL DEFAULT 'USD',
  slot_interval_min INTEGER NOT NULL DEFAULT 15,
  min_notice_min INTEGER NOT NULL DEFAULT 60,
  max_days_ahead INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','barber')),
  has_chair INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  share_earnings INTEGER NOT NULL DEFAULT 0,
  bio TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  duration_min INTEGER NOT NULL,
  price_cents INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS working_hours (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS time_off (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  shop_id INTEGER NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  service_name TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_phone TEXT NOT NULL DEFAULT '',
  client_note TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','cancelled','completed','no_show')),
  source TEXT NOT NULL DEFAULT 'online' CHECK (source IN ('online','walk_in')),
  quoted_cents INTEGER NOT NULL DEFAULT 0,
  charged_cents INTEGER,
  tip_cents INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT,
  started_at TEXT,
  finished_at TEXT,
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appt_barber_start ON appointments(barber_id, start_at);
CREATE INDEX IF NOT EXISTS idx_appt_shop_start ON appointments(shop_id, start_at);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY,
  barber_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  category TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
`;

export function openDb(file: string): Database.Database {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  return db;
}

const globalForDb = globalThis as unknown as { __db?: Database.Database };

export function getDb(): Database.Database {
  if (!globalForDb.__db) {
    globalForDb.__db = openDb(process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "autocoti.db"));
  }
  return globalForDb.__db;
}

/** Test hook: swap the process-wide database. */
export function setDb(db: Database.Database) {
  globalForDb.__db = db;
}

// ---- Row types ----
export type Shop = {
  id: number;
  name: string;
  slug: string;
  address: string;
  phone: string;
  timezone: string;
  currency: string;
  slot_interval_min: number;
  min_notice_min: number;
  max_days_ahead: number;
};

export type User = {
  id: number;
  shop_id: number;
  name: string;
  email: string;
  role: "owner" | "barber";
  has_chair: number;
  active: number;
  requires_approval: number;
  share_earnings: number;
  bio: string;
};

export type Service = {
  id: number;
  barber_id: number;
  name: string;
  duration_min: number;
  price_cents: number;
  active: number;
};

export type WorkingHours = { id: number; barber_id: number; weekday: number; start_min: number; end_min: number };
export type TimeOff = { id: number; barber_id: number; start_at: string; end_at: string; reason: string };

export type AppointmentStatus = "pending" | "confirmed" | "rejected" | "cancelled" | "completed" | "no_show";

export type Appointment = {
  id: number;
  shop_id: number;
  barber_id: number;
  service_id: number | null;
  service_name: string;
  client_name: string;
  client_phone: string;
  client_note: string;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  source: "online" | "walk_in";
  quoted_cents: number;
  charged_cents: number | null;
  tip_cents: number;
  payment_method: string | null;
  started_at: string | null;
  finished_at: string | null;
  token: string;
  created_at: string;
};

export type Expense = { id: number; barber_id: number; date: string; amount_cents: number; category: string; note: string };

export const USER_COLUMNS =
  "id, shop_id, name, email, role, has_chair, active, requires_approval, share_earnings, bio";
