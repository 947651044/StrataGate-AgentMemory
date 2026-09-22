import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { bm25Rank, normalizeSearchText, rrfRank, type RankedItem } from '@diqier/stratagate'
import { DshMetadataStore, type AgentMemoryRow } from './metadata.js'

export const AGENT_MEMORY_CATEGORIES = ['preference', 'decision', 'correction', 'fact'] as const

export type AgentMemoryCategory = (typeof AGENT_MEMORY_CATEGORIES)[number]
export type AgentMemoryStatus = 'active' | 'archived'

export interface AgentMemoryEntry {
  id: string
  sessionId: string
  content: string
  category?: AgentMemoryCategory
  createdAtMs: number
  lastReinforcedAtMs: number
  status: AgentMemoryStatus
  archivedAtMs?: number
}

export type WeightedAgentMemory = AgentMemoryEntry & { weight: number }

export interface AgentMemoryRecordResult {
  entry: WeightedAgentMemory
  duplicateOf?: string
}

export interface SessionAgentMemoryOptions {
  lambdaPerHour: number
  archiveThreshold: number
  maxActive: number
}

const HOUR_MS = 3_600_000

/**
 * Proportional (exponential) decay by wall-clock time. The anchor is the last
 * reinforcement (or creation) instant; weight is always computed lazily at
 * read time — nothing in this module keeps a timer.
 */
export function agentMemoryWeight(anchorMs: number, nowMs: number, lambdaPerHour: number): number {
  const hours = Math.max(0, (nowMs - anchorMs) / HOUR_MS)
  return Math.exp(-Math.max(0, lambdaPerHour) * hours)
}

export function agentMemoryIsStale(weight: number, threshold: number): boolean {
  return weight < threshold
}

function agentMemoryAnchor(entry: AgentMemoryEntry): number {
  return Math.max(entry.createdAtMs, entry.lastReinforcedAtMs)
}

function asCategory(value: string | null): AgentMemoryCategory | undefined {
  return value !== null && (AGENT_MEMORY_CATEGORIES as readonly string[]).includes(value)
    ? value as AgentMemoryCategory
    : undefined
}

function entryFromRow(row: AgentMemoryRow): AgentMemoryEntry {
  const category = asCategory(row.category)
  return {
    id: row.id,
    sessionId: row.sessionId,
    content: row.content,
    ...(category !== undefined ? { category } : {}),
    createdAtMs: row.createdAtMs,
    lastReinforcedAtMs: row.lastReinforcedAtMs,
    status: row.status === 'archived' ? 'archived' : 'active',
    ...(row.archivedAtMs !== null ? { archivedAtMs: row.archivedAtMs } : {}),
  }
}

function rowFromEntry(entry: AgentMemoryEntry): AgentMemoryRow {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    content: entry.content,
    category: entry.category ?? null,
    createdAtMs: entry.createdAtMs,
    lastReinforcedAtMs: entry.lastReinforcedAtMs,
    status: entry.status,
    archivedAtMs: entry.archivedAtMs ?? null,
  }
}

export class SessionAgentMemoryStore {
  private readonly cache = new Map<string, Map<string, AgentMemoryEntry>>()

  constructor(
    private readonly databasePath: string,
    private readonly options: SessionAgentMemoryOptions,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /**
   * Record one agent-authored fact for a single session. An exact duplicate of
   * an active entry refreshes its decay anchor instead of adding a new row.
   */
  record(sessionId: string, content: string, category?: AgentMemoryCategory, nowMs: number = Date.now()): AgentMemoryRecordResult {
    const key = sessionId.trim()
    const text = content.trim()
    if (!key) throw new TypeError('StrataGate agent memory session must not be empty')
    if (!text) throw new TypeError('StrataGate agent memory content must not be empty')
    const entries = this.loadSession(key)
    const normalized = normalizeSearchText(text)
    if (normalized) {
      for (const entry of entries.values()) {
        if (entry.status !== 'active') continue
        if (normalizeSearchText(entry.content) !== normalized) continue
        const refreshed: AgentMemoryEntry = { ...entry, lastReinforcedAtMs: nowMs }
        entries.set(entry.id, refreshed)
        this.persist((metadata) => metadata.updateAgentMemoryReinforcement(entry.id, nowMs))
        return {
          entry: { ...refreshed, weight: 1 },
          duplicateOf: entry.id,
        }
      }
    }
    const entry: AgentMemoryEntry = {
      id: `agentmem_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      sessionId: key,
      content: text,
      ...(category !== undefined ? { category } : {}),
      createdAtMs: nowMs,
      lastReinforcedAtMs: nowMs,
      status: 'active',
    }
    entries.set(entry.id, entry)
    this.persist((metadata) => metadata.insertAgentMemory(rowFromEntry(entry)))
    this.enforceMaxActive(key, entries, nowMs)
    return { entry: { ...entry, weight: 1 } }
  }

  /** Lazily compute weights, archive entries below the threshold, and return the actives. */
  listActive(sessionId: string, nowMs: number = Date.now(), limit?: number): WeightedAgentMemory[] {
    const key = sessionId.trim()
    if (!key) return []
    const entries = this.loadSession(key)
    const actives: WeightedAgentMemory[] = []
    for (const entry of entries.values()) {
      if (entry.status !== 'active') continue
      const weight = agentMemoryWeight(agentMemoryAnchor(entry), nowMs, this.options.lambdaPerHour)
      if (agentMemoryIsStale(weight, this.options.archiveThreshold)) {
        const archived: AgentMemoryEntry = { ...entry, status: 'archived', archivedAtMs: nowMs }
        entries.set(entry.id, archived)
        this.persist((metadata) => metadata.updateAgentMemoryStatus(entry.id, 'archived', nowMs))
        continue
      }
      actives.push({ ...entry, weight })
    }
    return actives
      .sort((left, right) => right.weight - left.weight
        || right.lastReinforcedAtMs - left.lastReinforcedAtMs
        || left.id.localeCompare(right.id))
      .slice(0, limit)
  }

  /** Rehearsal: citing an entry through memory_record_use resets its decay anchor. */
  reinforce(sessionId: string, ids: readonly string[], nowMs: number = Date.now()): { reinforced: WeightedAgentMemory[]; skipped: string[] } {
    const key = sessionId.trim()
    const reinforced: WeightedAgentMemory[] = []
    const skipped: string[] = []
    if (!key || ids.length === 0) return { reinforced, skipped }
    const entries = this.loadSession(key)
    for (const id of ids) {
      const entry = entries.get(id)
      if (!entry || entry.status !== 'active') {
        skipped.push(id)
        continue
      }
      const refreshed: AgentMemoryEntry = { ...entry, lastReinforcedAtMs: nowMs }
      entries.set(id, refreshed)
      this.persist((metadata) => metadata.updateAgentMemoryReinforcement(id, nowMs))
      reinforced.push({ ...refreshed, weight: agentMemoryWeight(nowMs, nowMs, this.options.lambdaPerHour) })
    }
    return { reinforced, skipped }
  }

  listForDashboard(options: { sessionId?: string; includeArchived?: boolean; nowMs?: number } = {}): { items: WeightedAgentMemory[]; total: number } {
    const nowMs = options.nowMs ?? Date.now()
    const requested = options.sessionId?.trim()
    const sessionIds = requested ? [requested] : this.knownSessionIds()
    const items: WeightedAgentMemory[] = []
    for (const sessionId of sessionIds) {
      const entries = this.loadSession(sessionId)
      for (const entry of entries.values()) {
        if (entry.status === 'active') {
          const weight = agentMemoryWeight(agentMemoryAnchor(entry), nowMs, this.options.lambdaPerHour)
          if (agentMemoryIsStale(weight, this.options.archiveThreshold)) {
            const archived: AgentMemoryEntry = { ...entry, status: 'archived', archivedAtMs: nowMs }
            entries.set(entry.id, archived)
            this.persist((metadata) => metadata.updateAgentMemoryStatus(entry.id, 'archived', nowMs))
            if (options.includeArchived !== true) continue
            items.push({ ...archived, weight })
            continue
          }
          items.push({ ...entry, weight })
          continue
        }
        if (options.includeArchived === true) items.push({ ...entry, weight: 0 })
      }
    }
    return {
      items: items.sort((left, right) => right.createdAtMs - left.createdAtMs || left.id.localeCompare(right.id)),
      total: items.length,
    }
  }

  close(): void {
    this.cache.clear()
  }

  /** BM25 ∪ high-weight fusion for merging agent memories into search results. */
  rankForSearch(sessionId: string, query: string, nowMs: number, limit: number): Array<RankedItem<WeightedAgentMemory>> {
    const actives = this.listActive(sessionId, nowMs)
    if (actives.length === 0) return []
    const lexical = bm25Rank(actives, query, (entry) => [entry.content, entry.category ?? ''])
      .map(({ item }) => item)
    const byWeight = [...actives]
      .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id))
      .slice(0, limit)
    return rrfRank([lexical, byWeight]).slice(0, limit)
  }

  private enforceMaxActive(sessionId: string, entries: Map<string, AgentMemoryEntry>, nowMs: number): void {
    const actives = [...entries.values()]
      .filter((entry) => entry.status === 'active')
      .map((entry) => ({ entry, weight: agentMemoryWeight(agentMemoryAnchor(entry), nowMs, this.options.lambdaPerHour) }))
    const excess = actives.length - this.options.maxActive
    if (excess <= 0) return
    const evicted = actives
      .sort((left, right) => left.weight - right.weight
        || left.entry.createdAtMs - right.entry.createdAtMs
        || left.entry.id.localeCompare(right.entry.id))
      .slice(0, excess)
    for (const { entry } of evicted) {
      entries.set(entry.id, { ...entry, status: 'archived', archivedAtMs: nowMs })
      this.persist((metadata) => metadata.updateAgentMemoryStatus(entry.id, 'archived', nowMs))
    }
  }

  private knownSessionIds(): string[] {
    const ids = new Set(this.cache.keys())
    if (this.databasePath !== ':memory:' && existsSync(this.databasePath)) {
      try {
        const metadata = new DshMetadataStore(this.databasePath)
        try {
          for (const sessionId of metadata.agentMemorySessionIds()) ids.add(sessionId)
        } finally {
          metadata.close()
        }
      } catch (error) {
        this.onError(error)
      }
    }
    return [...ids]
  }

  private loadSession(sessionId: string): Map<string, AgentMemoryEntry> {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const entries = new Map<string, AgentMemoryEntry>()
    if (this.databasePath !== ':memory:' && existsSync(this.databasePath)) {
      try {
        const metadata = new DshMetadataStore(this.databasePath)
        try {
          for (const row of metadata.agentMemories(sessionId)) {
            const entry = entryFromRow(row)
            entries.set(entry.id, entry)
          }
        } finally {
          metadata.close()
        }
      } catch (error) {
        this.onError(error)
      }
    }
    this.cache.set(sessionId, entries)
    return entries
  }

  private persist(operation: (metadata: DshMetadataStore) => void): void {
    if (this.databasePath === ':memory:') return
    let metadata: DshMetadataStore | undefined
    try {
      metadata = new DshMetadataStore(this.databasePath)
      operation(metadata)
    } catch (error) {
      this.onError(error)
    } finally {
      metadata?.close()
    }
  }
}
