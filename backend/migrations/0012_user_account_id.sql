-- Migration 0012: Add account_id to users table (per-schema)
-- Links tenant user to global account (docs/26-identidade-centralizada.md §3)

DO $$
BEGIN
  -- Add column if not exists
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'user'
      AND column_name = 'account_id'
  ) THEN
    ALTER TABLE "user"
    ADD COLUMN account_id TEXT
    REFERENCES public.account(id);
  END IF;
END $$;

-- Create index for lookup by account
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = 'user'
      AND indexname = 'idx_user_account_id'
  ) THEN
    CREATE INDEX idx_user_account_id ON "user"(account_id);
  END IF;
END $$;
