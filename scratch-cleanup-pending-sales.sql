-- One-time production cleanup: purge orphaned "held" sales left behind by the pre-migration-51
-- bug (held sales used to sync to the cloud; resuming/completing one locally hard-deleted the old
-- row without ever telling the cloud, since this sync system has no delete propagation — so the
-- orphan just sits there forever with saleStatus = 'pending'). These rows are the exact cause of
-- the delivery_note_number collisions on pull: a genuinely-active held sale would never reach the
-- cloud at all under the current code (see migration 51), so ANY 'pending' row here is provably
-- dead. Run the SELECT first, review the count/rows, then run the DELETE.

-- Step 1 — review before deleting.
SELECT id, "tenantId", "receiptNumber", "saleStatus", "localCreatedAt",
       delivery ->> 'deliveryNoteNumber' AS delivery_note_number
FROM sales
WHERE "saleStatus" = 'pending'
ORDER BY "tenantId", "localCreatedAt";

-- Step 2 — the actual cleanup. Wrapped in a transaction so it's all-or-nothing.
BEGIN;

DELETE FROM sales WHERE "saleStatus" = 'pending';

-- Sanity check — should return 0 rows.
SELECT count(*) AS remaining_pending_sales FROM sales WHERE "saleStatus" = 'pending';

COMMIT;
-- If the sanity check above looks wrong, run ROLLBACK; instead of COMMIT;
