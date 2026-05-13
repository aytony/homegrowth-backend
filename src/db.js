// src/db.js — uses sql.js (no C++ build tools required)
import initSqlJs from 'sql.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../data');
const DB_PATH = join(DATA_DIR, 'knowledge.db');

let db;

// ─── INITIALISE ────────────────────────────────────────────────────
export async function getDb() {
  if (db) return db;
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs();

  const isNew = !existsSync(DB_PATH);

  if (!isNew) {
    // Load existing DB — preserve all existing knowledge
    db = new SQL.Database(readFileSync(DB_PATH));
    // Only add missing tables, never drop or overwrite
    initSchema(false);
  } else {
    // Fresh DB — create schema and save
    db = new SQL.Database();
    initSchema(true);
  }

  return db;
}

// ─── PERSIST TO DISK ───────────────────────────────────────────────
export function saveDb() {
  if (db) writeFileSync(DB_PATH, Buffer.from(db.export()));
}

// ─── SCHEMA ────────────────────────────────────────────────────────
// isNew = true means we just created a fresh DB and must save immediately
// isNew = false means we loaded an existing DB — add missing tables but don't overwrite
function initSchema(isNew = false) {
  db.run(`CREATE TABLE IF NOT EXISTS knowledge_docs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tier TEXT NOT NULL,
    category TEXT,
    jurisdiction TEXT,
    client_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    effective_date TEXT,
    expiry_date TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL DEFAULT 'demo',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    sources TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS unanswered_questions (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    session_id TEXT,
    jurisdiction TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    admin_answer TEXT,
    resource_url TEXT,
    resource_title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at TEXT
  )`);

  // Only write to disk for a brand-new database
  if (isNew) saveDb();
}

// ─── QUERY HELPERS ─────────────────────────────────────────────────

// Run a SELECT — returns array of row objects
export function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Run a SELECT — returns first row or null
export function dbGet(sql, params = []) {
  return dbAll(sql, params)[0] || null;
}

// Run INSERT / UPDATE / DELETE — saves to disk automatically
export function dbRun(sql, params = []) {
  db.run(sql, params);
  saveDb();
}
