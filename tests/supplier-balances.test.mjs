import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { supplierBalances } from "../src/lib/supplier-balances.ts";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE suppliers (id TEXT, "tenantId" TEXT, status TEXT);
    CREATE TABLE purchases ("supplierId" TEXT, "tenantId" TEXT, "receivedValueCents" INTEGER, "shippingCostCents" INTEGER, "amountPaidCents" INTEGER);
    CREATE TABLE supplier_balance_entries ("supplierId" TEXT, "tenantId" TEXT, "referenceId" TEXT, "amountCents" INTEGER);
    INSERT INTO suppliers VALUES ('partial', 'tenant', 'active'), ('ordered', 'tenant', 'active'), ('credit', 'tenant', 'inactive'), ('empty', 'tenant', 'active'), ('foreign', 'other', 'active');
    INSERT INTO purchases VALUES ('partial', 'tenant', 20000, 1000, 5000), ('partial', 'tenant', 10000, 500, 10500), ('ordered', 'tenant', 0, 1000, 0), ('credit', 'tenant', 10000, 0, 12000), ('foreign', 'other', 999999, 0, 0);
    INSERT INTO supplier_balance_entries VALUES ('partial', 'tenant', 'purchase-1', 900000), ('partial', 'tenant', 'purchase-1', -300000), ('partial', 'tenant', NULL, 2000), ('partial', 'tenant', NULL, -500), ('partial', 'other', NULL, 999999);
  `);
  const tx = { $queryRaw: async (strings, ...values) => db.prepare(strings.join('?')).all(...values) };
  return { db, tx };
}

test("desktop parity: receipts, first-receipt shipping, payments, standalone adjustments and credits", async () => {
  const { db, tx } = fixture();
  try {
    const balances = await supplierBalances(tx, 'tenant');
    assert.deepEqual([...balances], [['partial', 17500], ['ordered', 0], ['credit', -2000], ['empty', 0]]);
    assert.equal([...balances.values()].reduce((a,b) => a+b, 0), 15500);
  } finally { db.close(); }
});

test("adjustment response uses the same formula and ignores purchase-linked corrections", async () => {
  const { db, tx } = fixture();
  try {
    db.prepare('INSERT INTO supplier_balance_entries VALUES (?, ?, NULL, ?)').run('partial', 'tenant', -1000);
    assert.deepEqual([...await supplierBalances(tx, 'tenant', 'partial')], [['partial', 16500]]);
    assert.equal((await supplierBalances(tx, 'tenant', 'foreign')).size, 0);
  } finally { db.close(); }
});

test("raw database bigint results become serializable numeric cents", async () => {
  const tx = { $queryRaw: async () => [{id: 'supplier', balanceCents: 12345n}] };
  assert.equal((await supplierBalances(tx, 'tenant')).get('supplier'), 12345);
});
