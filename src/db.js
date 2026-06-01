import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { bandForCost, layerForCategory } from './categories.js';

const DB_PATH = process.env.DB_PATH || './data/app.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    payday TEXT NOT NULL,
    salary REAL NOT NULL,
    survival_cost REAL NOT NULL DEFAULT 0,
    buffer REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    snapshot TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    cost REAL NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'lifestyle',
    bucket TEXT NOT NULL DEFAULT 'quality',
    priority INTEGER NOT NULL DEFAULT 3,
    type TEXT NOT NULL DEFAULT 'should',
    deadline TEXT,
    earliest_date TEXT,
    can_defer INTEGER NOT NULL DEFAULT 1,
    emotional INTEGER NOT NULL DEFAULT 3,
    trajectory INTEGER NOT NULL DEFAULT 3,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS wallets (
    id TEXT PRIMARY KEY,
    plan_id INTEGER,
    name TEXT NOT NULL,
    purpose TEXT,
    amount REAL NOT NULL DEFAULT 0,
    month TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL UNIQUE,
    target_amount REAL NOT NULL DEFAULT 0,
    saved_amount REAL NOT NULL DEFAULT 0,
    monthly_contribution REAL NOT NULL DEFAULT 0,
    deadline TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS goal_contributions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    goal_id INTEGER NOT NULL,
    plan_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(goal_id) REFERENCES goals(id) ON DELETE CASCADE,
    FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS investment_accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'asset',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS investment_updates (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    plan_id INTEGER,
    amount REAL NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(account_id) REFERENCES investment_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS allocation_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER,
    item_id INTEGER NOT NULL,
    amount REAL NOT NULL DEFAULT 0,
    scenario TEXT NOT NULL DEFAULT 'manual',
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY(plan_id) REFERENCES plans(id) ON DELETE SET NULL,
    FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE,
    UNIQUE(plan_id, item_id, source)
  );
`);

// ---- Миграция к новой таксономии (band / score_type / scores + новые слои и категории) ----
function itemColumns() {
  return db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
}
function planColumns() {
  return db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name);
}
function ensureColumn(col, def) {
  if (!itemColumns().includes(col)) db.exec(`ALTER TABLE items ADD COLUMN ${col} ${def}`);
}
function ensurePlanColumn(col, def) {
  if (!planColumns().includes(col)) db.exec(`ALTER TABLE plans ADD COLUMN ${col} ${def}`);
}

const hadBand = itemColumns().includes('band');
ensureColumn('band', "TEXT NOT NULL DEFAULT 'small'");
ensureColumn('score_type', "TEXT NOT NULL DEFAULT 'none'");
ensureColumn('scores', 'TEXT');
ensureColumn('saved_amount', 'REAL NOT NULL DEFAULT 0');
ensurePlanColumn('investment_fixed', 'REAL NOT NULL DEFAULT 0');

if (!hadBand) {
  // Перенос старых значений в новую таксономию (слой капитала + категория покупки).
  const OLD_BUCKET_TO_LAYER = {
    survival: 'survival', stability: 'stability', career: 'career',
    quality: 'quality', health: 'quality', gifts: 'quality',
  };
  const OLD_CATEGORY_TO_NEW = {
    food: 'lifestyle', transport: 'infrastructure', connectivity: 'infrastructure',
    essential_subs: 'infrastructure', family_debt: 'infrastructure',
    savings: 'asset', emergency: 'asset', insurance: 'infrastructure',
    courses: 'growth', books: 'growth', work_software: 'tool', work_gear: 'tool',
    certification: 'growth', networking: 'experience',
    clothing: 'status', dining: 'experience', entertainment: 'dopamine',
    hobby: 'experience', travel: 'experience', gadgets: 'tool',
    gym: 'lifestyle', nutrition: 'lifestyle', medical: 'infrastructure',
    gifts: 'experience', events: 'experience',
  };
  const NEW_CATEGORIES = new Set([
    'asset', 'tool', 'infrastructure', 'growth', 'experience',
    'lifestyle', 'status', 'dopamine', 'waste',
  ]);
  const rows = db.prepare('SELECT id, bucket, category, cost FROM items').all();
  const upd = db.prepare('UPDATE items SET bucket=?, category=?, band=? WHERE id=?');
  const run = db.transaction(() => {
    for (const r of rows) {
      const category = NEW_CATEGORIES.has(r.category)
        ? r.category
        : (OLD_CATEGORY_TO_NEW[r.category] || 'lifestyle');
      const layer = OLD_BUCKET_TO_LAYER[r.bucket] || layerForCategory(category);
      upd.run(layer, category, bandForCost(r.cost), r.id);
    }
  });
  run();
}

// ---- settings helpers ----
const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

export function getSetting(key, fallback = null) {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}
export function getJSON(key, fallback) {
  const v = getSetting(key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
export function setJSON(key, value) {
  setSetting(key, JSON.stringify(value));
}

// ---- item row <-> api object ----
export function rowToItem(r) {
  let scores = null;
  try { scores = r.scores ? JSON.parse(r.scores) : null; } catch { scores = null; }
  return {
    id: r.id,
    title: r.title,
    cost: r.cost,
    category: r.category,
    layer: r.bucket,
    bucket: r.bucket, // обратная совместимость
    band: r.band,
    scoreType: r.score_type,
    scores,
    savedAmount: r.saved_amount || 0,
    priority: r.priority,
    type: r.type,
    deadline: r.deadline,
    earliestDate: r.earliest_date,
    canDefer: !!r.can_defer,
    emotional: r.emotional,
    trajectory: r.trajectory,
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function rowToPlan(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    payday: r.payday,
    salary: r.salary,
    survivalCost: r.survival_cost,
    buffer: r.buffer,
    investmentFixed: r.investment_fixed || 0,
    status: r.status,
    snapshot: r.snapshot ? JSON.parse(r.snapshot) : null,
    createdAt: r.created_at,
    closedAt: r.closed_at,
  };
}

export function rowToWallet(r) {
  return {
    id: r.id,
    planId: r.plan_id,
    name: r.name,
    purpose: r.purpose || '',
    amount: r.amount,
    month: r.month,
    createdAt: r.created_at,
  };
}

export function rowToGoal(r) {
  return {
    id: r.id,
    itemId: r.item_id,
    targetAmount: r.target_amount,
    savedAmount: r.saved_amount,
    monthlyContribution: r.monthly_contribution,
    deadline: r.deadline,
    status: r.status,
    createdAt: r.created_at,
  };
}

export function rowToInvestmentUpdate(r) {
  return {
    id: r.id,
    accountId: r.account_id,
    name: r.account_name,
    accountType: r.account_type,
    amount: r.amount,
    date: r.date,
    note: r.note || '',
    planId: r.plan_id,
    createdAt: r.created_at,
  };
}

export function rowToAllocationDecision(r) {
  return {
    itemId: r.item_id,
    amount: r.amount,
    scenario: r.scenario,
    source: r.source,
  };
}

export default db;
