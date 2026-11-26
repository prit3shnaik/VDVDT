-- Cheap change-detection for large tables.
--
-- Every workspace page hydrates from a local cache and then re-fetches the whole
-- voters table to revalidate, which costs ~16k row reads per page view. This table
-- lets the client ask "did anything change?" in a single row read instead, and skip
-- the refetch entirely when the answer is no.
--
-- Maintained by triggers so it cannot drift from the data.

CREATE TABLE IF NOT EXISTS dataset_version (
  table_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Seed from the current table contents (safe to re-run).
INSERT INTO dataset_version (table_name, version, row_count, updated_at)
VALUES ('voters', 1, (SELECT COUNT(*) FROM voters), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
ON CONFLICT(table_name) DO UPDATE SET
  row_count = (SELECT COUNT(*) FROM voters),
  version = dataset_version.version + 1,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

DROP TRIGGER IF EXISTS voters_version_ai;
CREATE TRIGGER voters_version_ai AFTER INSERT ON voters BEGIN
  INSERT INTO dataset_version (table_name, version, row_count, updated_at)
  VALUES ('voters', 1, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(table_name) DO UPDATE SET
    version = dataset_version.version + 1,
    row_count = dataset_version.row_count + 1,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;

DROP TRIGGER IF EXISTS voters_version_au;
CREATE TRIGGER voters_version_au AFTER UPDATE ON voters BEGIN
  UPDATE dataset_version
  SET version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE table_name = 'voters';
END;

DROP TRIGGER IF EXISTS voters_version_ad;
CREATE TRIGGER voters_version_ad AFTER DELETE ON voters BEGIN
  UPDATE dataset_version
  SET version = version + 1,
      row_count = MAX(row_count - 1, 0),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE table_name = 'voters';
END;
