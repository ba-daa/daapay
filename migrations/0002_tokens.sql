-- One-time links: account invitations and password resets.
CREATE TABLE IF NOT EXISTS tokens (
  token   TEXT PRIMARY KEY,
  user_id TEXT    NOT NULL,
  kind    TEXT    NOT NULL,   -- 'invite' | 'reset'
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tokens_user ON tokens (user_id);
