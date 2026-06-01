import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import db, {
  getJSON, setJSON, rowToItem, rowToPlan, rowToWallet, rowToGoal,
  rowToInvestmentUpdate, rowToAllocationDecision,
} from './src/db.js';
import {
  pinIsSet, setPin, verifyPin, issueToken, clearToken, isAuthed, requireAuth,
} from './src/auth.js';
import {
  CATEGORIES, LAYERS, TYPES, BANDS, SCORE_TYPES, SCORE_CRITERIA,
  layerForCategory, bandForCost, recommendedScoreType,
} from './src/categories.js';
import {
  allocate, tradeoff, scenarioSummaries, SCENARIOS, scoreVerdict,
} from './src/allocation.js';
import { aiStatus, askAssistant, askAssistantText } from './src/ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Разумные дефолты под жизнь с родителями и доход ~25k грн.
const DEFAULTS = { salary: 25000, survivalCost: 6000, buffer: 1000, investmentFixed: 2000 };
const SETTINGS = {
  investments: 'investments',
  monthlyWallets: 'monthly_wallets',
  manualPlan: 'manual_plan',
};
const todayISO = () => new Date().toISOString().slice(0, 10);
const monthForPlan = (plan) => String(plan?.payday || todayISO()).slice(0, 7);

// ---------- prepared statements ----------
const stmt = {
  activePlan: db.prepare("SELECT * FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1"),
  planById: db.prepare('SELECT * FROM plans WHERE id = ?'),
  insertPlan: db.prepare(
    'INSERT INTO plans (name, payday, salary, survival_cost, buffer, investment_fixed) VALUES (@name, @payday, @salary, @survivalCost, @buffer, @investmentFixed)'
  ),
  updatePlan: db.prepare(
    'UPDATE plans SET name=@name, payday=@payday, salary=@salary, survival_cost=@survivalCost, buffer=@buffer, investment_fixed=@investmentFixed WHERE id=@id'
  ),
  closePlan: db.prepare("UPDATE plans SET status='closed', snapshot=@snapshot, closed_at=datetime('now') WHERE id=@id"),
  closedPlans: db.prepare("SELECT * FROM plans WHERE status='closed' ORDER BY closed_at DESC"),

  activeItems: db.prepare("SELECT * FROM items WHERE status='active' ORDER BY id DESC"),
  allItems: db.prepare('SELECT * FROM items ORDER BY id DESC'),
  itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
  insertItem: db.prepare(`INSERT INTO items
    (title, cost, category, bucket, band, score_type, scores, priority, type, deadline, earliest_date, can_defer, emotional, trajectory, notes)
    VALUES (@title,@cost,@category,@layer,@band,@scoreType,@scores,@priority,@type,@deadline,@earliestDate,@canDefer,@emotional,@trajectory,@notes)`),
  updateItem: db.prepare(`UPDATE items SET
    title=@title, cost=@cost, category=@category, bucket=@layer, band=@band, score_type=@scoreType, scores=@scores,
    priority=@priority, type=@type, deadline=@deadline, earliest_date=@earliestDate, can_defer=@canDefer, emotional=@emotional,
    trajectory=@trajectory, notes=@notes, updated_at=datetime('now') WHERE id=@id`),
  setItemStatus: db.prepare("UPDATE items SET status=@status, updated_at=datetime('now') WHERE id=@id"),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
  updateItemSavings: db.prepare('UPDATE items SET saved_amount=@savedAmount, updated_at=datetime(\'now\') WHERE id=@id'),

  walletsByPlan: db.prepare('SELECT * FROM wallets WHERE plan_id IS @planId ORDER BY created_at DESC'),
  upsertWallet: db.prepare(`INSERT INTO wallets (id, plan_id, name, purpose, amount, month)
    VALUES (@id, @planId, @name, @purpose, @amount, @month)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, purpose=excluded.purpose,
      amount=excluded.amount, month=excluded.month, updated_at=datetime('now')`),
  deleteWalletsForPlan: db.prepare('DELETE FROM wallets WHERE plan_id IS @planId'),

  goalsByItems: db.prepare('SELECT * FROM goals WHERE item_id IN (SELECT id FROM items) ORDER BY updated_at DESC'),
  goalByItem: db.prepare('SELECT * FROM goals WHERE item_id = ?'),
  upsertGoal: db.prepare(`INSERT INTO goals (item_id, target_amount, saved_amount, monthly_contribution, deadline, status)
    VALUES (@itemId, @targetAmount, @savedAmount, @monthlyContribution, @deadline, @status)
    ON CONFLICT(item_id) DO UPDATE SET target_amount=excluded.target_amount,
      saved_amount=excluded.saved_amount, monthly_contribution=excluded.monthly_contribution,
      deadline=excluded.deadline, status=excluded.status, updated_at=datetime('now')`),
  insertGoalContribution: db.prepare(`INSERT INTO goal_contributions (goal_id, plan_id, amount, date, note)
    VALUES (@goalId, @planId, @amount, @date, @note)`),

  investmentUpdates: db.prepare(`SELECT iu.*, ia.name AS account_name, ia.type AS account_type
    FROM investment_updates iu JOIN investment_accounts ia ON ia.id = iu.account_id
    ORDER BY iu.date DESC, iu.created_at DESC`),
  upsertInvestmentAccount: db.prepare(`INSERT INTO investment_accounts (id, name, type)
    VALUES (@id, @name, @type)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, type=excluded.type, updated_at=datetime('now')`),
  upsertInvestmentUpdate: db.prepare(`INSERT INTO investment_updates (id, account_id, plan_id, amount, date, note)
    VALUES (@id, @accountId, @planId, @amount, @date, @note)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, plan_id=excluded.plan_id,
      amount=excluded.amount, date=excluded.date, note=excluded.note`),
  deleteInvestmentUpdates: db.prepare('DELETE FROM investment_updates'),
  deleteUnusedInvestmentAccounts: db.prepare('DELETE FROM investment_accounts WHERE id NOT IN (SELECT account_id FROM investment_updates)'),

  decisionsByPlan: db.prepare("SELECT * FROM allocation_decisions WHERE plan_id IS @planId AND source='manual' ORDER BY updated_at DESC"),
  upsertDecision: db.prepare(`INSERT INTO allocation_decisions (plan_id, item_id, amount, scenario, source)
    VALUES (@planId, @itemId, @amount, @scenario, 'manual')
    ON CONFLICT(plan_id, item_id, source) DO UPDATE SET amount=excluded.amount,
      scenario=excluded.scenario, updated_at=datetime('now')`),
  deleteDecisionsForPlan: db.prepare("DELETE FROM allocation_decisions WHERE plan_id IS @planId AND source='manual'"),
  deleteGoal: db.prepare('DELETE FROM goals WHERE id = ?'),
  deleteGoalByItem: db.prepare('DELETE FROM goals WHERE item_id = ?'),
  allGoals: db.prepare('SELECT * FROM goals ORDER BY updated_at DESC'),
  allWallets: db.prepare('SELECT * FROM wallets ORDER BY created_at DESC'),
  allDecisions: db.prepare('SELECT * FROM allocation_decisions ORDER BY updated_at DESC'),
  allInvestmentAccounts: db.prepare('SELECT * FROM investment_accounts ORDER BY name'),
};

function getActivePlan() {
  return rowToPlan(stmt.activePlan.get());
}
function getActiveItems() {
  return stmt.activeItems.all().map(rowToItem);
}
function currentPlanId() {
  return getActivePlan()?.id || null;
}
function getInvestments() {
  const rows = stmt.investmentUpdates.all().map(rowToInvestmentUpdate);
  if (rows.length) return rows;
  return getJSON(SETTINGS.investments, []);
}
function getWallets() {
  const plan = getActivePlan();
  const rows = stmt.walletsByPlan.all({ planId: plan?.id || null }).map(rowToWallet);
  if (rows.length) return rows;
  return getJSON(SETTINGS.monthlyWallets, []);
}
function getManualPlan() {
  const rows = stmt.decisionsByPlan.all({ planId: currentPlanId() }).map(rowToAllocationDecision);
  if (rows.length) return rows.map(({ itemId, amount }) => ({ itemId, amount }));
  return getJSON(SETTINGS.manualPlan, null);
}
function getGoals() {
  return stmt.goalsByItems.all().map(rowToGoal);
}

function buildAIContext(scenario = 'balanced') {
  const plan = getActivePlan();
  const items = getActiveItems();
  const allocation = plan ? allocate(plan, items, { scenario, includeIds: scenario === 'custom' ? customIds() : null }) : null;
  return {
    plan,
    allocation: allocation && {
      totals: allocation.totals,
      approved: allocation.approved.map((a) => ({ title: a.item.title, cost: a.item.cost })),
      deferred: allocation.deferred.map((d) => ({ title: d.item.title, cost: d.item.cost, reason: d.reason })),
      policyTargets: allocation.policyTargets,
    },
    goals: getGoals(),
    wallets: getWallets(),
    investments: getInvestments(),
    itemsCount: items.length,
  };
}
function sanitizeEntries(entries, fields) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => {
    const out = { id: String(entry.id || Date.now() + Math.random()) };
    for (const field of fields) {
      if (field.type === 'number') out[field.key] = Math.max(0, Number(entry[field.key]) || 0);
      else out[field.key] = String(entry[field.key] || '').trim();
    }
    return out;
  }).filter((entry) => fields.some((field) => field.type === 'number' ? entry[field.key] > 0 : entry[field.key]));
}
function sanitizeManualPlan(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    itemId: Number(entry.itemId),
    amount: Math.max(0, Number(entry.amount) || 0),
  })).filter((entry) => entry.itemId && entry.amount > 0);
}

const VALID_CATEGORIES = new Set(CATEGORIES.map((c) => c.id));
const VALID_LAYERS = new Set(Object.keys(LAYERS));

function normalizeItemInput(b) {
  const category = VALID_CATEGORIES.has(b.category) ? b.category : 'lifestyle';
  // Слой по умолчанию берётся из категории, но пользователь может переопределить.
  const layer = VALID_LAYERS.has(b.layer) ? b.layer : layerForCategory(category);
  const cost = Math.max(0, Number(b.cost) || 0);
  const band = bandForCost(cost);
  const scoreType = ['none', 'quick', 'full'].includes(b.scoreType) ? b.scoreType : 'none';
  let scores = null;
  if (scoreType !== 'none' && b.scores && typeof b.scores === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(b.scores)) {
      const n = parseInt(v, 10);
      if (n >= 1 && n <= 5) clean[k] = n;
    }
    if (Object.keys(clean).length) scores = JSON.stringify(clean);
  }
  return {
    title: String(b.title || '').trim() || 'Без названия',
    cost,
    category,
    layer,
    band,
    scoreType,
    scores,
    priority: Math.min(5, Math.max(1, parseInt(b.priority, 10) || 3)),
    type: ['must', 'should', 'nice'].includes(b.type) ? b.type : 'should',
    deadline: b.deadline || null,
    earliestDate: b.earliestDate || null,
    canDefer: b.canDefer === false || b.canDefer === 0 ? 0 : 1,
    emotional: Math.min(5, Math.max(1, parseInt(b.emotional, 10) || 3)),
    trajectory: Math.min(5, Math.max(1, parseInt(b.trajectory, 10) || 3)),
    notes: b.notes ? String(b.notes) : null,
  };
}

// ================= AUTH =================
app.get('/api/auth/status', (req, res) => {
  res.json({ pinSet: pinIsSet(), authed: isAuthed(req) });
});

app.post('/api/auth/setup', (req, res) => {
  if (pinIsSet()) return res.status(400).json({ error: 'pin_already_set' });
  const pin = String(req.body?.pin || '');
  if (pin.length < 4) return res.status(400).json({ error: 'pin_too_short' });
  setPin(pin);
  issueToken(res);
  res.json({ ok: true });
});

app.post('/api/auth/login', (req, res) => {
  const pin = String(req.body?.pin || '');
  if (!verifyPin(pin)) return res.status(401).json({ error: 'bad_pin' });
  issueToken(res);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearToken(res);
  res.json({ ok: true });
});

// ================= META =================
function metaPayload() {
  return {
    categories: CATEGORIES,
    layers: LAYERS,
    buckets: LAYERS, // обратная совместимость
    types: TYPES,
    bands: BANDS,
    scoreTypes: SCORE_TYPES,
    scoreCriteria: SCORE_CRITERIA,
    scenarios: Object.entries(SCENARIOS).map(([key, v]) => ({ key, label: v.label })),
    defaults: DEFAULTS,
    ai: aiStatus(),
  };
}

app.get('/api/meta', requireAuth, (req, res) => {
  res.json(metaPayload());
});

// ================= PLAN =================
app.get('/api/plan', requireAuth, (req, res) => {
  res.json({ plan: getActivePlan() });
});

app.post('/api/plan', requireAuth, (req, res) => {
  const b = req.body || {};
  const payload = {
    name: String(b.name || 'Зарплата').trim() || 'Зарплата',
    payday: b.payday || new Date().toISOString().slice(0, 10),
    salary: Math.max(0, Number(b.salary) || 0),
    survivalCost: Math.max(0, Number(b.survivalCost) || 0),
    buffer: Math.max(0, Number(b.buffer) || 0),
    investmentFixed: Math.max(0, Number(b.investmentFixed) || 0),
  };
  const existing = getActivePlan();
  if (existing) {
    stmt.updatePlan.run({ ...payload, id: existing.id });
    res.json({ plan: rowToPlan(stmt.planById.get(existing.id)) });
  } else {
    const info = stmt.insertPlan.run(payload);
    res.json({ plan: rowToPlan(stmt.planById.get(info.lastInsertRowid)) });
  }
});

// Закрыть месяц: snapshot, купленное -> bought, отложенное остаётся active.
app.post('/api/plan/close', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: 'no_active_plan' });
  const items = getActiveItems();
  const result = allocate(plan, items, { scenario: req.body?.scenario || 'balanced' });

  const snapshot = {
    closedScenario: result.scenario,
    totals: result.totals,
    buckets: result.buckets,
    approved: result.approved.map((a) => ({ title: a.item.title, cost: a.item.cost, layer: a.item.layer })),
    deferred: result.deferred.map((d) => ({ title: d.item.title, cost: d.item.cost, reason: d.reason })),
  };
  stmt.closePlan.run({ id: plan.id, snapshot: JSON.stringify(snapshot) });

  // Купленное архивируем (bought), отложенное оставляем в мастер-листе.
  const approvedIds = new Set(result.approved.map((a) => a.item.id));
  const mark = db.transaction(() => {
    for (const id of approvedIds) stmt.setItemStatus.run({ id, status: 'bought' });
  });
  mark();

  res.json({ ok: true, snapshot });
});

// ================= ITEMS (master wishlist) =================
app.get('/api/items', requireAuth, (req, res) => {
  const rows = req.query.all ? stmt.allItems.all() : stmt.activeItems.all();
  res.json({ items: rows.map(rowToItem) });
});

app.post('/api/items', requireAuth, (req, res) => {
  const payload = normalizeItemInput(req.body || {});
  const info = stmt.insertItem.run(payload);
  res.json({ item: rowToItem(stmt.itemById.get(info.lastInsertRowid)) });
});

app.put('/api/items/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!stmt.itemById.get(id)) return res.status(404).json({ error: 'not_found' });
  const payload = normalizeItemInput(req.body || {});
  stmt.updateItem.run({ ...payload, id });
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.post('/api/items/:id/status', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const status = ['active', 'bought', 'archived'].includes(req.body?.status) ? req.body.status : 'active';
  if (!stmt.itemById.get(id)) return res.status(404).json({ error: 'not_found' });
  stmt.setItemStatus.run({ id, status });
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.post('/api/items/:id/savings', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const item = stmt.itemById.get(id);
  if (!item) return res.status(404).json({ error: 'not_found' });
  const savedAmount = Math.max(0, Number(req.body?.savedAmount) || 0);
  stmt.updateItemSavings.run({ id, savedAmount });
  const existingGoal = stmt.goalByItem.get(id);
  const goalPayload = {
    itemId: id,
    targetAmount: Number(item.cost) || 0,
    savedAmount,
    monthlyContribution: Math.max(0, Number(req.body?.monthlyContribution ?? existingGoal?.monthly_contribution ?? 0)),
    deadline: req.body?.deadline || existingGoal?.deadline || item.deadline,
    status: savedAmount >= (Number(item.cost) || 0) ? 'complete' : 'active',
  };
  stmt.upsertGoal.run(goalPayload);
  const goal = stmt.goalByItem.get(id);
  if (Number(req.body?.contributionAmount) > 0) {
    stmt.insertGoalContribution.run({
      goalId: goal.id,
      planId: currentPlanId(),
      amount: Math.max(0, Number(req.body.contributionAmount) || 0),
      date: req.body?.date || todayISO(),
      note: req.body?.note || '',
    });
  }
  res.json({ item: rowToItem(stmt.itemById.get(id)) });
});

app.get('/api/goals', requireAuth, (req, res) => {
  res.json({ goals: getGoals() });
});
app.post('/api/goals', requireAuth, (req, res) => {
  const itemId = Number(req.body?.itemId);
  const item = stmt.itemById.get(itemId);
  if (!item) return res.status(404).json({ error: 'item_not_found' });
  const savedAmount = Math.max(0, Number(req.body?.savedAmount) || 0);
  stmt.upsertGoal.run({
    itemId,
    targetAmount: Math.max(0, Number(req.body?.targetAmount ?? item.cost) || 0),
    savedAmount,
    monthlyContribution: Math.max(0, Number(req.body?.monthlyContribution) || 0),
    deadline: req.body?.deadline || item.deadline || null,
    status: req.body?.status || (savedAmount >= Number(item.cost) ? 'complete' : 'active'),
  });
  stmt.updateItemSavings.run({ id: itemId, savedAmount });
  res.json({ goal: rowToGoal(stmt.goalByItem.get(itemId)), item: rowToItem(stmt.itemById.get(itemId)) });
});
app.delete('/api/goals/:id', requireAuth, (req, res) => {
  stmt.deleteGoal.run(Number(req.params.id));
  res.json({ ok: true });
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  stmt.deleteItem.run(Number(req.params.id));
  res.json({ ok: true });
});

// ================= ALLOCATION =================
function customIds() {
  return getJSON('custom_include', null);
}

app.get('/api/allocation', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.json({ plan: null, allocation: null });
  const scenario = req.query.scenario || 'balanced';
  const allocation = allocate(plan, getActiveItems(), {
    scenario,
    includeIds: scenario === 'custom' ? customIds() : null,
  });
  res.json({ plan, allocation });
});

app.get('/api/scenarios', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.json({ scenarios: [] });
  res.json({ scenarios: scenarioSummaries(plan, getActiveItems(), customIds()) });
});

app.post('/api/whatif', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: 'no_active_plan' });
  const draft = {
    ...plan,
    salary: Math.max(0, Number(req.body?.salary ?? plan.salary) || 0),
    survivalCost: Math.max(0, Number(req.body?.survivalCost ?? plan.survivalCost) || 0),
    buffer: Math.max(0, Number(req.body?.buffer ?? plan.buffer) || 0),
    investmentFixed: Math.max(0, Number(req.body?.investmentFixed ?? plan.investmentFixed) || 0),
  };
  const scenario = req.body?.scenario || req.query.scenario || 'balanced';
  res.json({ plan: draft, allocation: allocate(draft, getActiveItems(), { scenario }) });
});

app.get('/api/custom-scenario', requireAuth, (req, res) => {
  res.json({ includeIds: customIds() || [] });
});
app.post('/api/custom-scenario', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body?.includeIds) ? req.body.includeIds.map(Number) : [];
  setJSON('custom_include', ids);
  res.json({ includeIds: ids });
});

app.get('/api/investments', requireAuth, (req, res) => {
  res.json({ investments: getInvestments() });
});
app.post('/api/investments', requireAuth, (req, res) => {
  const investments = sanitizeEntries(req.body?.investments, [
    { key: 'name', type: 'text' },
    { key: 'accountType', type: 'text' },
    { key: 'amount', type: 'number' },
    { key: 'date', type: 'text' },
    { key: 'note', type: 'text' },
  ]);
  const planId = currentPlanId();
  const save = db.transaction(() => {
    stmt.deleteInvestmentUpdates.run();
    investments.forEach((entry) => {
      const accountName = entry.name || 'Инвестиция';
      const accountId = String(entry.accountId || accountName.toLowerCase().replace(/\s+/g, '-'));
      const updateId = String(entry.id || `${accountId}-${entry.date || todayISO()}-${Date.now()}`);
      stmt.upsertInvestmentAccount.run({
        id: accountId,
        name: accountName,
        type: entry.accountType || 'asset',
      });
      stmt.upsertInvestmentUpdate.run({
        id: updateId,
        accountId,
        planId,
        amount: entry.amount,
        date: entry.date || todayISO(),
        note: entry.note || '',
      });
    });
    stmt.deleteUnusedInvestmentAccounts.run();
  });
  save();
  res.json({ investments: getInvestments() });
});

app.get('/api/wallets', requireAuth, (req, res) => {
  res.json({ wallets: getWallets() });
});
app.post('/api/wallets', requireAuth, (req, res) => {
  const wallets = sanitizeEntries(req.body?.wallets, [
    { key: 'name', type: 'text' },
    { key: 'purpose', type: 'text' },
    { key: 'amount', type: 'number' },
  ]);
  const plan = getActivePlan();
  const planId = plan?.id || null;
  const month = monthForPlan(plan);
  const save = db.transaction(() => {
    stmt.deleteWalletsForPlan.run({ planId });
    wallets.forEach((wallet) => stmt.upsertWallet.run({
      id: String(wallet.id || Date.now() + Math.random()),
      planId,
      name: wallet.name || 'Кошелёк',
      purpose: wallet.purpose || '',
      amount: wallet.amount,
      month,
    }));
  });
  save();
  res.json({ wallets: getWallets() });
});

app.get('/api/manual-plan', requireAuth, (req, res) => {
  res.json({ manualPlan: getManualPlan() || [] });
});
app.post('/api/manual-plan', requireAuth, (req, res) => {
  const manualPlan = sanitizeManualPlan(req.body?.manualPlan);
  const planId = currentPlanId();
  const save = db.transaction(() => {
    stmt.deleteDecisionsForPlan.run({ planId });
    manualPlan.forEach((entry) => stmt.upsertDecision.run({
      planId,
      itemId: entry.itemId,
      amount: entry.amount,
      scenario: req.body?.scenario || 'manual',
    }));
  });
  save();
  res.json({ manualPlan: getManualPlan() || [] });
});

app.get('/api/export', requireAuth, (req, res) => {
  const payload = {
    version: 2,
    exportedAt: new Date().toISOString(),
    plans: db.prepare('SELECT * FROM plans ORDER BY id').all().map(rowToPlan),
    items: stmt.allItems.all().map(rowToItem),
    wallets: stmt.allWallets.all().map(rowToWallet),
    goals: stmt.allGoals.all().map(rowToGoal),
    investments: getInvestments(),
    allocationDecisions: stmt.allDecisions.all().map(rowToAllocationDecision),
  };
  res.json(payload);
});

app.post('/api/import', requireAuth, (req, res) => {
  const data = req.body || {};
  const save = db.transaction(() => {
    if (Array.isArray(data.wallets)) {
      stmt.deleteWalletsForPlan.run({ planId: currentPlanId() });
      data.wallets.forEach((w) => stmt.upsertWallet.run({
        id: String(w.id || Date.now() + Math.random()),
        planId: currentPlanId(),
        name: String(w.name || 'Кошелёк'),
        purpose: String(w.purpose || ''),
        amount: Math.max(0, Number(w.amount) || 0),
        month: w.month || monthForPlan(getActivePlan()),
      }));
    }
    if (Array.isArray(data.investments)) {
      stmt.deleteInvestmentUpdates.run();
      data.investments.forEach((entry) => {
        const accountName = entry.name || 'Инвестиция';
        const accountId = String(entry.accountId || accountName.toLowerCase().replace(/\s+/g, '-'));
        stmt.upsertInvestmentAccount.run({ id: accountId, name: accountName, type: entry.accountType || 'asset' });
        stmt.upsertInvestmentUpdate.run({
          id: String(entry.id || `${accountId}-${entry.date || todayISO()}-${Date.now()}`),
          accountId,
          planId: currentPlanId(),
          amount: Math.max(0, Number(entry.amount) || 0),
          date: entry.date || todayISO(),
          note: entry.note || '',
        });
      });
    }
    if (Array.isArray(data.goals)) {
      data.goals.forEach((g) => {
        if (stmt.itemById.get(Number(g.itemId))) stmt.upsertGoal.run({
          itemId: Number(g.itemId),
          targetAmount: Math.max(0, Number(g.targetAmount) || 0),
          savedAmount: Math.max(0, Number(g.savedAmount) || 0),
          monthlyContribution: Math.max(0, Number(g.monthlyContribution) || 0),
          deadline: g.deadline || null,
          status: g.status || 'active',
        });
      });
    }
  });
  save();
  res.json({ ok: true });
});

app.get('/api/tradeoff/:id', requireAuth, (req, res) => {
  const plan = getActivePlan();
  if (!plan) return res.status(400).json({ error: 'no_active_plan' });
  const scenario = req.query.scenario || 'balanced';
  const t = tradeoff(Number(req.params.id), plan, getActiveItems(), {
    scenario,
    includeIds: scenario === 'custom' ? customIds() : null,
  });
  if (!t) return res.status(404).json({ error: 'not_found' });
  res.json(t);
});

// ================= HISTORY =================
app.get('/api/history', requireAuth, (req, res) => {
  res.json({ history: stmt.closedPlans.all().map(rowToPlan) });
});

// ================= AGGREGATE STATE =================
app.get('/api/state', requireAuth, (req, res) => {
  const plan = getActivePlan();
  const items = getActiveItems();
  const scenario = req.query.scenario || 'balanced';
  const allocation = plan
    ? allocate(plan, items, { scenario, includeIds: scenario === 'custom' ? customIds() : null })
    : null;
  res.json({
    plan,
    items,
    allocation,
    scenarios: plan ? scenarioSummaries(plan, items, customIds()) : [],
    history: stmt.closedPlans.all().map(rowToPlan),
    meta: metaPayload(),
    investments: getInvestments(),
    wallets: getWallets(),
    manualPlan: getManualPlan() || [],
    goals: getGoals(),
  });
});

// ================= AI =================
app.get('/api/ai/status', requireAuth, (req, res) => res.json(aiStatus()));

app.get('/api/ai/tip', requireAuth, async (req, res) => {
  try {
    const context = buildAIContext(req.query.scenario || 'balanced');
    const out = await askAssistantText('Дай один короткий совет по текущему плану зарплаты: что сделать первым и чего избегать.', context);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'ai_failed', detail: String(e.message || e) });
  }
});

app.post('/api/ai/explain', requireAuth, async (req, res) => {
  try {
    const item = stmt.itemById.get(Number(req.body?.itemId));
    if (!item) return res.status(404).json({ error: 'not_found' });
    const cleanItem = rowToItem(item);
    const verdict = scoreVerdict(cleanItem);
    const context = { ...buildAIContext(req.body?.scenario || 'balanced'), item: cleanItem, verdict };
    const out = await askAssistantText(`Объясни кратко вердикт для желания "${cleanItem.title}" и что с ним делать.`, context);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'ai_failed', detail: String(e.message || e) });
  }
});

app.post('/api/ai/chat', requireAuth, async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const context = buildAIContext('balanced');
    const out = await askAssistant(messages, context);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'ai_failed', detail: String(e.message || e) });
  }
});

app.post('/api/ai/chat/stream', requireAuth, async (req, res) => {
  try {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    const out = await askAssistant(messages, buildAIContext('balanced'));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    for (const word of String(out.reply || '').split(/(\s+)/)) res.write(word);
    res.end();
  } catch (e) {
    res.status(500).end(`Ошибка ассистента: ${String(e.message || e)}`);
  }
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Salary Allocation Planner на http://localhost:${PORT}`));
