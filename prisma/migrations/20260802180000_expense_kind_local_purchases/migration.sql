-- AlterTable
-- Mirrors DESKTOP's migration 53 (expense_kind_local_purchases). Existing rows all get 'general' —
-- every expense synced before today genuinely was one.
ALTER TABLE "expenses" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'general';
