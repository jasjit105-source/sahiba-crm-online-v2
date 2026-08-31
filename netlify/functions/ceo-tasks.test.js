// Lightweight tests for Tareas mañana helpers (no Neon required).
const assert = require('assert');
const {
  normalizeAgent,
  appendNotaCeo,
  mexicoDate,
  serializeTask,
} = require('./ceo-tasks');

function testNormalizeAgent() {
  assert.strictEqual(normalizeAgent('Jazmin'), 'jazmin');
  assert.strictEqual(normalizeAgent('NANCY'), 'nancy');
  assert.strictEqual(normalizeAgent('yoana'), 'yoana');
  assert.strictEqual(normalizeAgent('Jazmin Diaz'), 'jazmin');
  assert.strictEqual(normalizeAgent('Unassigned'), '');
  assert.strictEqual(normalizeAgent(''), '');
}

function testAppendNeverOverwrites() {
  const first = appendNotaCeo('', 'Llamar a María');
  assert.ok(first.includes('Llamar a María'));
  assert.ok(/\[\d{2} \w{3} \d{4}/.test(first), 'Mexico timestamp prefix: ' + first);

  const second = appendNotaCeo(first, 'Ya contestó');
  assert.ok(second.startsWith(first), 'must keep previous CEO text');
  assert.ok(second.includes('Ya contestó'));
  assert.ok(second.indexOf('Llamar a María') < second.indexOf('Ya contestó'));
  assert.notStrictEqual(second, 'Ya contestó');
}

function testMexicoDateFormat() {
  const d = mexicoDate();
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(d), 'YYYY-MM-DD: ' + d);
}

function testSerializeDoesNotTouchLeadNotes() {
  const row = {
    id: 3,
    contact_id: 'c1',
    phone: '5512345678',
    phone_normalized: '5512345678',
    name: 'Maria',
    agent: 'jazmin',
    nota_ceo: '[31 ago 2026, 08:00] Hola',
    hecho: false,
    notes: 'GIRL COMMENT MUST NEVER APPEAR',
    follow_up_status: 'Pendiente',
    status: 'open',
  };
  const out = serializeTask(row);
  assert.strictEqual(out.nota_ceo, row.nota_ceo);
  assert.strictEqual(out.agent, 'jazmin');
  assert.strictEqual(out.hecho, false);
  assert.ok(!('notes' in out));
  assert.ok(!('follow_up_status' in out));
}

testNormalizeAgent();
testAppendNeverOverwrites();
testMexicoDateFormat();
testSerializeDoesNotTouchLeadNotes();
console.log('ceo-tasks helper tests: ok');
