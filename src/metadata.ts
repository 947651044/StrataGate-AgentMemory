import { DatabaseSync } from 'node:sqlite'

export interface AgentMemoryRow {
  id: string
  sessionId: string
  content: string
  category: string | null
  createdAtMs: number
  lastReinforcedAtMs: number
  status: string
  archivedAtMs: number | null
}

const METADATA_SCHEMA = `
CREATE TABLE IF NOT EXISTS stratagate_dsh_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS stratagate_dsh_workspaces (
  namespace TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS stratagate_dsh_feedback_drafts (
  namespace TEXT PRIMARY KEY,
  draft_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS stratagate_dsh_agent_memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  content TEXT NOT NULL,
  category TEXT,
  created_at_ms INTEGER NOT NULL,
  last_reinforced_at_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  archived_at_ms INTEGER,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS stratagate_dsh_agent_memories_session
  ON stratagate_dsh_agent_memories (session_id, status);
`

export class DshMetadataStore {
  private readonly database: DatabaseSync

  constructor(filename: string) {
    this.database = new DatabaseSync(filename)
    this.database.exec(METADATA_SCHEMA)
  }

  blockTurnSize(): number | null {
    const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'blockTurnSize'")
      .get() as { value: string } | undefined
    const value = Number(row?.value)
    return Number.isSafeInteger(value) && value >= 1 ? value : null
  }

  setBlockTurnSize(value: number): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError('blockTurnSize must be a positive integer')
    }
    this.setSetting('blockTurnSize', value)
  }

  blockDecayLambda(): number | null {
    const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'blockDecayLambda'")
      .get() as { value: string } | undefined
    const value = Number(row?.value)
    return Number.isFinite(value) && value >= 0 ? value : null
  }

  setBlockDecayLambda(value: number): void {
    if (!Number.isFinite(value) || value < 0) {
      throw new TypeError('blockDecayLambda must be a non-negative finite number')
    }
    this.setSetting('blockDecayLambda', value)
  }

  lastFeedbackPromptAt(): string | null {
    const row = this.database.prepare("SELECT value FROM stratagate_dsh_settings WHERE key = 'lastFeedbackPromptAt'")
      .get() as { value: string } | undefined
    return row?.value ?? null
  }

  setLastFeedbackPromptAt(value: string): void {
    this.setSettingValue('lastFeedbackPromptAt', value)
  }

  private setSetting(key: string, value: number): void {
    this.setSettingValue(key, String(value))
  }

  private setSettingValue(key: string, value: string): void {
    this.database.prepare(`
      INSERT INTO stratagate_dsh_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(key, value, new Date().toISOString())
  }

  workspaceName(namespace: string): string | null {
    const row = this.database.prepare('SELECT display_name FROM stratagate_dsh_workspaces WHERE namespace = ?')
      .get(namespace) as { display_name: string } | undefined
    return row?.display_name ?? null
  }

  rememberWorkspace(namespace: string, displayName: string): void {
    const name = displayName.trim()
    if (!namespace.trim() || !name) return
    this.database.prepare(`
      INSERT INTO stratagate_dsh_workspaces (namespace, display_name, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (namespace) DO UPDATE SET display_name = excluded.display_name, updated_at = excluded.updated_at
    `).run(namespace, name, new Date().toISOString())
  }

  feedbackDraft(namespace: string): unknown | null {
    const row = this.database.prepare('SELECT draft_json FROM stratagate_dsh_feedback_drafts WHERE namespace = ?')
      .get(namespace) as { draft_json: string } | undefined
    if (!row) return null
    try {
      return JSON.parse(row.draft_json)
    } catch {
      return null
    }
  }

  setFeedbackDraft(namespace: string, draft: unknown): void {
    this.database.prepare(`
      INSERT INTO stratagate_dsh_feedback_drafts (namespace, draft_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT (namespace) DO UPDATE SET draft_json = excluded.draft_json, updated_at = excluded.updated_at
    `).run(namespace, JSON.stringify(draft), new Date().toISOString())
  }

  agentMemories(sessionId: string): AgentMemoryRow[] {
    const rows = this.database.prepare(`
      SELECT id, session_id, content, category, created_at_ms, last_reinforced_at_ms, status, archived_at_ms
      FROM stratagate_dsh_agent_memories
      WHERE session_id = ?
      ORDER BY created_at_ms DESC, id DESC
    `).all(sessionId) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      content: String(row.content),
      category: row.category === null || row.category === undefined ? null : String(row.category),
      createdAtMs: Number(row.created_at_ms),
      lastReinforcedAtMs: Number(row.last_reinforced_at_ms),
      status: String(row.status),
      archivedAtMs: row.archived_at_ms === null || row.archived_at_ms === undefined ? null : Number(row.archived_at_ms),
    }))
  }

  agentMemorySessionIds(): string[] {
    const rows = this.database
      .prepare('SELECT DISTINCT session_id FROM stratagate_dsh_agent_memories')
      .all() as Array<Record<string, unknown>>
    return rows.map((row) => String(row.session_id))
  }

  insertAgentMemory(row: AgentMemoryRow): void {
    this.database.prepare(`
      INSERT INTO stratagate_dsh_agent_memories (
        id, session_id, content, category, created_at_ms, last_reinforced_at_ms, status, archived_at_ms, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.sessionId,
      row.content,
      row.category,
      row.createdAtMs,
      row.lastReinforcedAtMs,
      row.status,
      row.archivedAtMs,
      new Date().toISOString(),
    )
  }

  updateAgentMemoryStatus(id: string, status: string, archivedAtMs: number | null): void {
    this.database.prepare(`
      UPDATE stratagate_dsh_agent_memories
      SET status = ?, archived_at_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(status, archivedAtMs, new Date().toISOString(), id)
  }

  updateAgentMemoryReinforcement(id: string, lastReinforcedAtMs: number): void {
    this.database.prepare(`
      UPDATE stratagate_dsh_agent_memories
      SET last_reinforced_at_ms = ?, updated_at = ?
      WHERE id = ?
    `).run(lastReinforcedAtMs, new Date().toISOString(), id)
  }

  close(): void {
    this.database.close()
  }
}
