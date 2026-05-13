// src/knowledge.js
import { getDb, dbAll } from './db.js';

// ─── RETRIEVE relevant docs for a query ───────────────────────────
export async function retrieveKnowledge(query, { clientId = 'demo', jurisdiction = null, limit = 3 } = {}) {
  await getDb();
  const today = new Date().toISOString().split('T')[0];

  const keywords = query
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter(w => w.length > 3)
    .slice(0, 8);

  if (keywords.length === 0) return [];

  // Fetch all active docs and score in JS (sql.js has limited LIKE support)
  const allDocs = dbAll(
    `SELECT * FROM knowledge_docs
     WHERE status = 'active'
     AND (expiry_date IS NULL OR expiry_date >= ?)`,
    [today]
  );

  return allDocs
    .filter(doc => {
      if (doc.tier === 'client' && doc.client_id !== clientId) return false;
      if (jurisdiction && doc.jurisdiction && doc.jurisdiction !== 'federal' && doc.jurisdiction !== jurisdiction) return false;
      return true;
    })
    .map(doc => {
      const score = keywords.reduce((s, k) => {
        if (doc.title.toLowerCase().includes(k)) s += 3;
        if (doc.content.toLowerCase().includes(k)) s += 1;
        return s;
      }, 0);
      return { ...doc, score };
    })
    .filter(d => d.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...doc }) => doc);
}

// ─── GET ALL docs with optional filters ───────────────────────────
export async function getAllDocs({ tier, status } = {}) {
  await getDb();
  let sql = 'SELECT * FROM knowledge_docs WHERE 1=1';
  const params = [];
  if (tier)   { sql += ' AND tier = ?';   params.push(tier); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  sql += ' ORDER BY tier, created_at DESC';
  return dbAll(sql, params);
}
