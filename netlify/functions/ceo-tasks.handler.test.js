// In-memory handler test — mocks Neon so we never touch production.
const assert = require('assert');
const path = require('path');

process.env.APP_TOKEN = 'test-token-ceo';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused';

const store = [];
let nextId = 1;

function fakeSql(strings, ...values) {
  const text = strings.join(' ? ').replace(/\s+/g, ' ').trim();
  const u = text.toUpperCase();
  if (u.startsWith('CREATE')) return Promise.resolve([]);
  if (u.includes('INSERT INTO CEO_TASKS')) {
    const row = {
      id: nextId++,
      contact_id: values[0] || '',
      phone: values[1] || '',
      phone_normalized: values[2] || '',
      name: values[3] || '',
      agent: values[4] || '',
      nota_ceo: values[5] || '',
      hecho: false,
      hecho_por: null,
      hecho_at: null,
      batch_date: values[6],
      status: 'open',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.push(row);
    return Promise.resolve([{ ...row }]);
  }
  if (u.includes('UPDATE CEO_TASKS SET') && u.includes('HECHO = TRUE')) {
    const id = values[values.length - 1];
    const row = store.find((t) => t.id === id);
    if (!row) return Promise.resolve([]);
    row.hecho = true;
    row.hecho_por = values[0];
    row.hecho_at = new Date().toISOString();
    row.status = 'done';
    row.updated_at = new Date().toISOString();
    return Promise.resolve([{ ...row }]);
  }
  if (u.includes('UPDATE CEO_TASKS SET')) {
    const id = values[values.length - 1];
    const row = store.find((t) => t.id === id);
    if (!row) return Promise.resolve([]);
    row.nota_ceo = values[0];
    row.name = values[1];
    row.contact_id = values[2];
    row.phone = values[3];
    row.phone_normalized = values[4];
    row.agent = values[5];
    row.batch_date = values[6];
    row.updated_at = new Date().toISOString();
    return Promise.resolve([{ ...row }]);
  }
  if (u.includes('SELECT * FROM CEO_TASKS WHERE ID')) {
    const row = store.find((t) => t.id === values[0]);
    return Promise.resolve(row ? [{ ...row }] : []);
  }
  if (u.includes("STATUS = 'OPEN' AND PHONE_NORMALIZED")) {
    return Promise.resolve(store.filter((t) => t.status === 'open' && t.phone_normalized === values[0]).map((t) => ({ ...t })));
  }
  if (u.includes("STATUS = 'OPEN' AND CONTACT_ID")) {
    return Promise.resolve(store.filter((t) => t.status === 'open' && t.contact_id === values[0]).map((t) => ({ ...t })));
  }
  if (u.includes('WHERE AGENT = ? AND STATUS =')) {
    return Promise.resolve(store.filter((t) => t.agent === values[0] && t.status === values[1]).map((t) => ({ ...t })));
  }
  if (u.includes('WHERE AGENT =')) {
    return Promise.resolve(store.filter((t) => t.agent === values[0]).map((t) => ({ ...t })));
  }
  if (u.includes('WHERE STATUS =')) {
    return Promise.resolve(store.filter((t) => t.status === values[0]).map((t) => ({ ...t })));
  }
  if (u.includes('SELECT * FROM CEO_TASKS')) {
    return Promise.resolve(store.map((t) => ({ ...t })));
  }
  throw new Error('Unmocked SQL: ' + text);
}

const sharedPath = require.resolve('./_shared');
const shared = require('./_shared');
require.cache[sharedPath].exports = Object.assign({}, shared, { db: () => fakeSql });
delete require.cache[require.resolve('./ceo-tasks')];
const { handler } = require('./ceo-tasks');

function event(method, { qs, body, auth } = {}) {
  return {
    httpMethod: method,
    queryStringParameters: qs || {},
    body: body ? JSON.stringify(body) : '',
    headers: auth ? { Authorization: 'Bearer ' + auth } : {},
  };
}

async function call(e) {
  const res = await handler(e);
  return { status: res.statusCode, body: JSON.parse(res.body || '{}') };
}

(async function run() {
  const denied = await call(event('POST', {
    body: { action: 'upsert', phone: '5511111111', nota_ceo: 'secret' },
  }));
  assert.strictEqual(denied.status, 401);

  const created = await call(event('POST', {
    auth: 'test-token-ceo',
    body: { action: 'upsert', phone: '+52 55 1234 5678', name: 'Maria', agent: 'Jazmin', nota_ceo: 'Llamar hoy' },
  }));
  assert.strictEqual(created.status, 200, JSON.stringify(created.body));
  assert.strictEqual(created.body.action, 'created');
  assert.ok(created.body.task.nota_ceo.includes('Llamar hoy'));
  assert.strictEqual(created.body.task.agent, 'jazmin');
  assert.strictEqual(created.body.task.phone_normalized, '5512345678');
  const id = created.body.task.id;

  const appended = await call(event('POST', {
    auth: 'test-token-ceo',
    body: { action: 'upsert', phone: '5512345678', nota_ceo: 'Pide mayoreo' },
  }));
  assert.strictEqual(appended.status, 200);
  assert.strictEqual(appended.body.action, 'appended');
  assert.ok(appended.body.task.nota_ceo.includes('Llamar hoy'));
  assert.ok(appended.body.task.nota_ceo.includes('Pide mayoreo'));

  const listed = await call(event('GET', { qs: { agent: 'jazmin', status: 'open' } }));
  assert.strictEqual(listed.status, 200);
  assert.strictEqual(listed.body.tasks.length, 1);
  assert.strictEqual(listed.body.tasks[0].id, id);

  const hecho = await call(event('POST', {
    body: { action: 'hecho', id, hecho_por: 'jazmin' },
  }));
  assert.strictEqual(hecho.status, 200);
  assert.strictEqual(hecho.body.task.hecho, true);
  assert.strictEqual(hecho.body.task.status, 'done');
  assert.strictEqual(hecho.body.task.hecho_por, 'jazmin');
  assert.ok(hecho.body.task.hecho_at_mx);

  const openAfter = await call(event('GET', { qs: { status: 'open' } }));
  assert.strictEqual(openAfter.body.tasks.length, 0);

  console.log('ceo-tasks handler tests: ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
