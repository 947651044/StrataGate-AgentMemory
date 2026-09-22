import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentMemoryIsStale, agentMemoryWeight, SessionAgentMemoryStore } from '../src/agent-memory.js'

const HOUR_MS = 3_600_000
const OPTIONS = { lambdaPerHour: 0.7, archiveThreshold: 0.05, maxActive: 64 }

describe('agent memory decay math', () => {
  it('keeps full weight at the anchor and decays exponentially by wall-clock hours', () => {
    const now = 1_700_000_000_000
    expect(agentMemoryWeight(now, now, 0.7)).toBe(1)
    expect(agentMemoryWeight(now, now + HOUR_MS, 0.7)).toBeCloseTo(Math.exp(-0.7), 12)
    expect(agentMemoryWeight(now, now + 2 * HOUR_MS, 0.7)).toBeCloseTo(Math.exp(-1.4), 12)
    // Negative elapsed time (clock skew) never increases weight.
    expect(agentMemoryWeight(now + HOUR_MS, now, 0.7)).toBe(1)
    expect(agentMemoryWeight(now, now + HOUR_MS, 0)).toBe(1)
  })

  it('flags stale entries strictly below the archive threshold', () => {
    expect(agentMemoryIsStale(0.05, 0.05)).toBe(false)
    expect(agentMemoryIsStale(0.0499, 0.05)).toBe(true)
  })
})

describe('SessionAgentMemoryStore', () => {
  it('records, weights, and lazily archives entries by elapsed time', () => {
    const store = new SessionAgentMemoryStore(':memory:', OPTIONS)
    const base = 1_700_000_000_000
    const { entry } = store.record('s1', '用户偏好 pnpm。', 'preference', base)
    expect(entry.status).toBe('active')
    expect(entry.weight).toBe(1)

    const afterTwoHours = store.listActive('s1', base + 2 * HOUR_MS)
    expect(afterTwoHours).toHaveLength(1)
    expect(afterTwoHours[0]!.weight).toBeCloseTo(Math.exp(-1.4), 12)

    // Past the threshold the entry flips to archived, is persisted as such, and
    // disappears from later active listings.
    const farOut = base + 100 * HOUR_MS
    expect(store.listActive('s1', farOut)).toHaveLength(0)
    expect(store.listForDashboard({ sessionId: 's1', includeArchived: true, nowMs: farOut }).items).toEqual([
      expect.objectContaining({ id: entry.id, status: 'archived' }),
    ])
    expect(store.listActive('s1', farOut + HOUR_MS)).toHaveLength(0)
  })

  it('reinforces only active entries and resets their decay anchor', () => {
    const store = new SessionAgentMemoryStore(':memory:', OPTIONS)
    const base = 1_700_000_000_000
    const { entry } = store.record('s1', '用户偏好 pnpm。', 'preference', base)
    const reinforcedAt = base + HOUR_MS
    const reinforcement = store.reinforce('s1', [entry.id, 'agentmem_missing'], reinforcedAt)
    expect(reinforcement.reinforced.map(({ id }) => id)).toEqual([entry.id])
    expect(reinforcement.reinforced[0]!.weight).toBe(1)
    expect(reinforcement.skipped).toEqual(['agentmem_missing'])
    // One hour after reinforcement the anchor moved, so weight is still high.
    expect(store.listActive('s1', reinforcedAt + HOUR_MS)[0]!.weight).toBeCloseTo(Math.exp(-0.7), 12)
  })

  it('treats an exact duplicate as a reinforcement instead of a new entry', () => {
    const store = new SessionAgentMemoryStore(':memory:', OPTIONS)
    const base = 1_700_000_000_000
    const first = store.record('s1', '用户偏好 pnpm。', 'preference', base)
    const second = store.record('s1', ' 用户偏好 pnpm。  ', 'fact', base + HOUR_MS)
    expect(second.duplicateOf).toBe(first.entry.id)
    expect(second.entry.id).toBe(first.entry.id)
    expect(second.entry.weight).toBe(1)
    expect(store.listActive('s1', base + HOUR_MS)).toHaveLength(1)
  })

  it('rejects empty content and empty sessions', () => {
    const store = new SessionAgentMemoryStore(':memory:', OPTIONS)
    expect(() => store.record('s1', '   ')).toThrow(TypeError)
    expect(() => store.record('  ', 'content')).toThrow(TypeError)
  })

  it('archives the lowest-weight oldest entries beyond the per-session cap', () => {
    const store = new SessionAgentMemoryStore(':memory:', { ...OPTIONS, maxActive: 3 })
    const base = 1_700_000_000_000
    store.record('s1', 'fact one', 'fact', base)
    store.record('s1', 'fact two', 'fact', base + HOUR_MS)
    store.record('s1', 'fact three', 'fact', base + 2 * HOUR_MS)
    const fourth = store.record('s1', 'fact four', 'fact', base + 3 * HOUR_MS)
    const actives = store.listActive('s1', base + 3 * HOUR_MS)
    expect(actives.map(({ content }) => content)).toEqual(['fact four', 'fact three', 'fact two'])
    expect(fourth.entry.id).toBe(actives[0]!.id)
    const archived = store.listForDashboard({ sessionId: 's1', includeArchived: true, nowMs: base + 3 * HOUR_MS })
    expect(archived.items.find(({ content }) => content === 'fact one')?.status).toBe('archived')
  })

  it('survives a restart through the SQLite metadata table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-agent-memory-'))
    const database = join(directory, 'memory.db')
    const base = 1_700_000_000_000
    try {
      const first = new SessionAgentMemoryStore(database, OPTIONS)
      const { entry } = first.record('s1', '用户偏好 pnpm。', 'preference', base)
      first.record('s2', '另一个会话的事实', 'fact', base)
      first.close()

      const second = new SessionAgentMemoryStore(database, OPTIONS)
      try {
        const actives = second.listActive('s1', base + HOUR_MS)
        expect(actives.map(({ id, content }) => ({ id, content }))).toEqual([
          { id: entry.id, content: '用户偏好 pnpm。' },
        ])
        expect(actives[0]!.category).toBe('preference')
        // Sessions are isolated even in a shared store.
        expect(second.listActive('s3', base + HOUR_MS)).toHaveLength(0)
        const dashboard = second.listForDashboard({ includeArchived: false, nowMs: base + HOUR_MS })
        expect(dashboard.items.map(({ sessionId }) => sessionId).sort()).toEqual(['s1', 's2'])
        // Reinforcement persists too.
        second.reinforce('s1', [entry.id], base + 2 * HOUR_MS)
        second.close()
        const third = new SessionAgentMemoryStore(database, OPTIONS)
        try {
          expect(third.listActive('s1', base + 3 * HOUR_MS)[0]!.weight).toBeCloseTo(Math.exp(-0.7), 12)
        } finally {
          third.close()
        }
      } finally {
        second.close()
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps :memory: databases cache-only and reports persistence errors without throwing', async () => {
    const errors: unknown[] = []
    const store = new SessionAgentMemoryStore('Z:\\definitely\\missing\\directory\\memory.db', OPTIONS, (error) => errors.push(error))
    try {
      const { entry } = store.record('s1', '事实。', 'fact')
      expect(entry.status).toBe('active')
      expect(store.listActive('s1')).toHaveLength(1)
      expect(errors).toHaveLength(1)
      expect(store.listForDashboard({ nowMs: Date.now() }).total).toBe(1)
    } finally {
      store.close()
    }
    expect(new SessionAgentMemoryStore(':memory:', OPTIONS).listActive('never-loaded')).toEqual([])
  })
})
