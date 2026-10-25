-- DAA Pay: document store (one row per record, grouped by collection),
-- sign-in sessions, uploaded-file index and a simple attempt counter.

CREATE TABLE IF NOT EXISTS docs (
  col     TEXT    NOT NULL,             -- users, regs, items, clients, projects, bens, notifs, log
  id      TEXT    NOT NULL,
  data    TEXT    NOT NULL,             -- JSON body
  ts      INTEGER NOT NULL,             -- last change, ms since epoch (drives sync)
  deleted INTEGER NOT NULL DEFAULT 0,   -- tombstone so clients learn about deletions
  PRIMARY KEY (col, id)
);
CREATE INDEX IF NOT EXISTS docs_ts ON docs (ts);

CREATE TABLE IF NOT EXISTS sessions (
  token    TEXT PRIMARY KEY,
  user_id  TEXT    NOT NULL,
  stage    TEXT    NOT NULL,            -- 'full' | 'code' (waiting for 2-step code) | 'setup' (must set up 2-step)
  pending  TEXT,                        -- 2-step secret being set up
  created  INTEGER NOT NULL,
  expires  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);

CREATE TABLE IF NOT EXISTS files (
  id      TEXT PRIMARY KEY,
  name    TEXT    NOT NULL,
  type    TEXT    NOT NULL,
  size    INTEGER NOT NULL,
  created INTEGER NOT NULL,
  by      TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS attempts (
  k     TEXT PRIMARY KEY,               -- e.g. 'login:<ip>:<email>'
  n     INTEGER NOT NULL,
  reset INTEGER NOT NULL
);
