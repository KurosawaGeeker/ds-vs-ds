CREATE TABLE IF NOT EXISTS votes (
  voter_id TEXT PRIMARY KEY,
  choice TEXT NOT NULL CHECK (choice IN ('left', 'right')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS totals (
  choice TEXT PRIMARY KEY CHECK (choice IN ('left', 'right')),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0)
);
INSERT OR IGNORE INTO totals (choice, total) VALUES ('left', 0), ('right', 0);
CREATE TRIGGER IF NOT EXISTS vote_insert AFTER INSERT ON votes BEGIN
  UPDATE totals SET total = total + 1 WHERE choice = NEW.choice;
END;
CREATE TRIGGER IF NOT EXISTS vote_delete AFTER DELETE ON votes BEGIN
  UPDATE totals SET total = total - 1 WHERE choice = OLD.choice;
END;
