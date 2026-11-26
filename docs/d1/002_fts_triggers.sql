-- ===========================================================================
-- 002_fts_triggers.sql — Workspace-aware FTS5 + change stamps
--
-- Apply AFTER 001_schema.sql:
--   npx wrangler d1 execute voterdata --remote --file=./docs/d1/002_fts_triggers.sql
--
-- voters_fts is database-wide. workspace_id is stored as an UNINDEXED column so
-- every query can be constrained to one workspace. The Worker must still JOIN
-- voters and filter `v.workspace_id = ?`; FTS alone is never an ACL.
--
-- Query pattern:
--   SELECT v.* FROM voters v
--   JOIN voters_fts f ON f.rowid = v.rowid
--   WHERE voters_fts MATCH ? AND v.workspace_id = ?
--   LIMIT 50;
-- ===========================================================================

PRAGMA foreign_keys = ON;

CREATE VIRTUAL TABLE IF NOT EXISTS voters_fts USING fts5(
  name,
  epic_no,
  contact_no_1,
  relative_name,
  house_no,
  workspace_id UNINDEXED,
  content = 'voters',
  content_rowid = 'rowid'
);

DROP TRIGGER IF EXISTS voters_fts_ai;
DROP TRIGGER IF EXISTS voters_fts_ad;
DROP TRIGGER IF EXISTS voters_fts_au;

CREATE TRIGGER voters_fts_ai AFTER INSERT ON voters BEGIN
  INSERT INTO voters_fts(rowid, name, epic_no, contact_no_1, relative_name, house_no, workspace_id)
  VALUES (new.rowid, new.name, new.epic_no, new.contact_no_1, new.relative_name, new.house_no, new.workspace_id);
END;

CREATE TRIGGER voters_fts_ad AFTER DELETE ON voters BEGIN
  INSERT INTO voters_fts(voters_fts, rowid, name, epic_no, contact_no_1, relative_name, house_no, workspace_id)
  VALUES ('delete', old.rowid, old.name, old.epic_no, old.contact_no_1, old.relative_name, old.house_no, old.workspace_id);
END;

CREATE TRIGGER voters_fts_au AFTER UPDATE ON voters BEGIN
  INSERT INTO voters_fts(voters_fts, rowid, name, epic_no, contact_no_1, relative_name, house_no, workspace_id)
  VALUES ('delete', old.rowid, old.name, old.epic_no, old.contact_no_1, old.relative_name, old.house_no, old.workspace_id);
  INSERT INTO voters_fts(rowid, name, epic_no, contact_no_1, relative_name, house_no, workspace_id)
  VALUES (new.rowid, new.name, new.epic_no, new.contact_no_1, new.relative_name, new.house_no, new.workspace_id);
END;

-- ---------------------------------------------------------------------------
-- Dataset change stamps, per workspace. The client caches one workspace roll
-- and asks for this stamp before revalidating.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS voters_version_ai;
DROP TRIGGER IF EXISTS voters_version_au;
DROP TRIGGER IF EXISTS voters_version_ad;

CREATE TRIGGER voters_version_ai AFTER INSERT ON voters BEGIN
  INSERT INTO dataset_version (workspace_id, table_name, version, row_count, updated_at)
  VALUES (new.workspace_id, 'voters', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(workspace_id, table_name) DO UPDATE SET
    version = dataset_version.version + 1,
    row_count = dataset_version.row_count + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER voters_version_au AFTER UPDATE ON voters BEGIN
  INSERT INTO dataset_version (workspace_id, table_name, version, row_count, updated_at)
  VALUES (new.workspace_id, 'voters', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(workspace_id, table_name) DO UPDATE SET
    version = dataset_version.version + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

CREATE TRIGGER voters_version_ad AFTER DELETE ON voters BEGIN
  INSERT INTO dataset_version (workspace_id, table_name, version, row_count, updated_at)
  VALUES (old.workspace_id, 'voters', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(workspace_id, table_name) DO UPDATE SET
    version = dataset_version.version + 1,
    row_count = MAX(dataset_version.row_count - 1, 0),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

-- Rebuild the index from the content table after a bulk load.
INSERT INTO voters_fts(voters_fts) VALUES ('rebuild');
