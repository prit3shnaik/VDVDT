-- FTS5 index for voter search (replaces tsvector + pg_trgm + search_voters)
-- Apply AFTER 001_schema.sql and AFTER data import, or apply before import
-- and let triggers keep FTS in sync during load.
--
-- Query pattern in the Worker:
--   SELECT v.*
--   FROM voters v
--   JOIN voters_fts f ON f.rowid = v.rowid
--   WHERE voters_fts MATCH ?
--   LIMIT 50;

CREATE VIRTUAL TABLE IF NOT EXISTS voters_fts USING fts5(
  name,
  epic_no,
  contact_no_1,
  relative_name,
  house_no,
  content = 'voters',
  content_rowid = 'rowid'
);

CREATE TRIGGER IF NOT EXISTS voters_fts_ai AFTER INSERT ON voters BEGIN
  INSERT INTO voters_fts(rowid, name, epic_no, contact_no_1, relative_name, house_no)
  VALUES (new.rowid, new.name, new.epic_no, new.contact_no_1, new.relative_name, new.house_no);
END;

CREATE TRIGGER IF NOT EXISTS voters_fts_ad AFTER DELETE ON voters BEGIN
  INSERT INTO voters_fts(voters_fts, rowid, name, epic_no, contact_no_1, relative_name, house_no)
  VALUES ('delete', old.rowid, old.name, old.epic_no, old.contact_no_1, old.relative_name, old.house_no);
END;

CREATE TRIGGER IF NOT EXISTS voters_fts_au AFTER UPDATE ON voters BEGIN
  INSERT INTO voters_fts(voters_fts, rowid, name, epic_no, contact_no_1, relative_name, house_no)
  VALUES ('delete', old.rowid, old.name, old.epic_no, old.contact_no_1, old.relative_name, old.house_no);
  INSERT INTO voters_fts(rowid, name, epic_no, contact_no_1, relative_name, house_no)
  VALUES (new.rowid, new.name, new.epic_no, new.contact_no_1, new.relative_name, new.house_no);
END;

-- Rebuild from content table after a bulk CSV import that bypassed triggers
-- (wrangler d1 execute of INSERT files usually DOES fire triggers; rebuild
-- is still the safest post-load step).
INSERT INTO voters_fts(voters_fts) VALUES ('rebuild');
