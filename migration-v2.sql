CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Cuộc trò chuyện mới',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversations_session
ON conversations (session_id, updated_at DESC);

ALTER TABLE messages ADD COLUMN conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_conversation
ON messages (conversation_id, id);
