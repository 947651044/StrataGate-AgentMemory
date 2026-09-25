import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import { StrataGate, estimateTokens, type BlockContextEntry, type MemoryBlock } from '@diqier/stratagate'
import { describe, expect, it, vi } from 'vitest'
import type { DshModelBridge } from '../src/llm.js'
import { StrataGateRuntime } from '../src/runtime.js'

const models = {
  run: async <T>(_session: Session, operation: () => Promise<T>): Promise<T> => operation(),
  runDetached: async <T>(_id: string, operation: () => Promise<T>): Promise<T> => operation(),
  isReady: () => true,
  onAdaptersUpdated: () => () => {},
  summarizer: async () => ({
    l0Title: 'saved work', l0Tags: [], l1Summary: 'Saved work summary.',
    l2Keypoints: ['Saved work summary.'], shouldExtract: false,
  }),
  extractor: async () => ({ shouldExtract: false, reason: 'none', events: [] }),
  graphProjector: async () => ({ reason: 'none', nodes: [], edges: [] }),
} as unknown as DshModelBridge

function runtime(database: string, bridge: DshModelBridge = models): StrataGateRuntime {
  return new StrataGateRuntime({
    database, namespaceMode: 'session', namespacePrefix: 'dsh', globalNamespace: 'global',
    blockTurnSize: 1, blockDecayLambda: 0.3, ingestSubagents: false, maxOutputTokens: 2048,
  }, bridge)
}

function appendTurn(session: Session, user: string, assistant: string, toolResult?: string): SessionSeq | undefined {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: user }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  if (toolResult) {
    const callId = 'issue81-call' as never
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: callId, name: 'inspect', arguments: '{"path":"large"}' }],
        source: { provider: 'test', model: 'test' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'inspect', arguments: '{"path":"large"}' })
    const event = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'text', text: toolResult }], isError: false }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    return event.seq
  }
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: assistant }], source: { provider: 'test', model: 'test' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return undefined
}

function replace(runtime: StrataGateRuntime, session: Session, block: MemoryBlock, context: BlockContextEntry): boolean {
  return (runtime as unknown as { replaceSealedSurface: (
    session: Session, block: MemoryBlock, context: BlockContextEntry, endTurn: number,
  ) => boolean }).replaceSealedSurface(session, block, context, 1)
}

function turnEndAt(session: Session): string {
  const ended = session.snapshotEvents().find((event) => event.type === 'turn/end')
  if (!ended) throw new Error('Expected completed DSH turn')
  return new Date(ended.time).toISOString()
}

describe('Issue #81 surface ownership and size', () => {
  it('keeps full L5 tool evidence after prune but writes only a smaller visible level', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-prune-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-prune' as never)
    const largeResult = 'FULL TOOL RESULT '.repeat(7000)
    const user = 'Inspect the data and summarize it. '.repeat(150)
    const toolSeq = appendTurn(session, user, 'done', largeResult)!
    const original = session.eventAt(toolSeq)!
    if (original.type !== 'tool/result') throw new Error('Expected original tool result')
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-prune', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor, graphProjector: models.graphProjector,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({
        user, assistant: 'done', threadId: String(session.id), createdAt: turnEndAt(session),
        assistantToolCalls: [{ name: 'inspect', arguments: { path: 'large' }, result: largeResult }],
      })
      const block = memory.listBlocks()[0]!
      const context = memory.getBlockContext(String(session.id))[0]!
      expect(context.level).toBe(5)
      const append = session.append.bind(session) as (...args: unknown[]) => unknown
      append('compaction/prune', {
        shadowedRange: { start: toolSeq, end: toolSeq }, shadowedSeqs: [toolSeq], shadowedTokenCount: 20_000,
      })
      const pruned = session.append('tool/result', {
        ...original.data,
        message: {
          ...original.data.message,
          content: [{
            ...original.data.message.content[0]!,
            content: [{ type: 'text', text: '[pruned by DSH]' }],
          }],
        },
      }, { surfaceOp: { op: 'replace', startSeq: toolSeq, endSeq: toolSeq }, sourceEventSeqs: [toolSeq] })
      const before = estimateTokens(JSON.stringify(session.deriveMessages()))
      expect(replace(plugin, session, block, context)).toBe(true)
      const checkpoint = session.eventAt(session.surface.nodes[0]!)!
      expect(checkpoint.sourceEventSeqs).toContain(pruned.seq)
      expect(session.deriveMessages()).toHaveLength(1)
      const after = estimateTokens(JSON.stringify(session.deriveMessages()))
      expect(after).toBeLessThan(before * 0.9)
      expect(JSON.stringify(session.deriveMessages())).not.toContain('FULL TOOL RESULT')
      expect(JSON.stringify(session.deriveMessages())).not.toContain('Level: L5')
      expect(block.l5Raw[1]?.toolCalls?.[0]?.result).toBe(largeResult)
      await memory.close()
      const reopened = await StrataGate.open({ database, namespace: 'dsh:session:issue81-prune' })
      try {
        expect(reopened.listBlocks()[0]?.l5Raw[1]?.toolCalls?.[0]?.result).toBe(largeResult)
      } finally { await reopened.close() }
    } finally {
      await plugin.close()
      await memory.close().catch(() => {})
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not replace while host compaction is open or restore history it has consumed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-compact-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-compact' as never)
    const user = 'A completed historical request. '.repeat(100)
    appendTurn(session, user, 'A completed answer. '.repeat(100))
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-compact', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor, graphProjector: models.graphProjector,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({ user, assistant: 'A completed answer. '.repeat(100), threadId: String(session.id), createdAt: turnEndAt(session) })
      const block = memory.listBlocks()[0]!
      const context = memory.getBlockContext(String(session.id))[0]!
      const oldNodes = [...session.surface.nodes]
      const append = session.append.bind(session) as (...args: unknown[]) => unknown
      append('compaction/start', { compactionId: 'test-compact', turn: null })
      expect(replace(plugin, session, block, context)).toBe(false)
      expect(session.surface.nodes).toEqual(oldNodes)
      append('compaction/summary', {
        compactionId: 'test-compact', summary: [{ type: 'text', text: 'Host summary' }],
        shadowedRange: { start: oldNodes[0], end: oldNodes.at(-1) },
        shadowedSeqs: oldNodes, shadowedTokenCount: 10_000, provider: 'test', model: 'test',
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Host summary' }],
        source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
      }), {
        surfaceOp: { op: 'replace', startSeq: oldNodes[0]!, endSeq: oldNodes.at(-1)! },
        sourceEventSeqs: oldNodes,
      })
      append('compaction/end', { compactionId: 'test-compact', turn: null })
      expect(replace(plugin, session, block, context)).toBe(false)
      expect(session.deriveMessages()).toHaveLength(1)
      expect(JSON.stringify(session.deriveMessages())).not.toContain('[StrataGate conversation block]')
      expect(memory.listBlocks()[0]?.processingStatus).toBe('ready')
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('finishes background Block work during host Compact without a stale write or later rebound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-race-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-race' as never)
    appendTurn(session, 'Original request. '.repeat(200), 'Original answer. '.repeat(200))
    let release!: () => void
    let started = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const bridge = {
      ...models,
      summarizer: async () => {
        started = true
        await gate
        return { l0Title: 'stored', l0Tags: [], l1Summary: 'stored', l2Keypoints: [], shouldExtract: false }
      },
    } as unknown as DshModelBridge
    const plugin = runtime(database, bridge)
    try {
      for (const event of session.snapshotEvents()) plugin.acceptEvent(session, event)
      await plugin.flush()
      await vi.waitFor(() => expect(started).toBe(true))
      const oldNodes = [...session.surface.nodes]
      const append = session.append.bind(session) as (...args: unknown[]) => unknown
      append('compaction/start', { compactionId: 'race-compact', turn: null })
      release()
      await vi.waitFor(async () => {
        const snapshot = await plugin.adminSnapshot(plugin.namespaceFor(session))
        expect(snapshot?.blocks[0]?.processingStatus).toBe('ready')
      })
      expect(session.surface.nodes).toEqual(oldNodes)
      append('compaction/summary', {
        compactionId: 'race-compact', summary: [{ type: 'text', text: 'Host retained summary' }],
        shadowedRange: { start: oldNodes[0], end: oldNodes.at(-1) },
        shadowedSeqs: oldNodes, shadowedTokenCount: 10_000, provider: 'test', model: 'test',
      })
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'Host retained summary' }],
        source: { kind: 'plugin', plugin: 'dsh-compaction-basic' },
      }), {
        surfaceOp: { op: 'replace', startSeq: oldNodes[0]!, endSeq: oldNodes.at(-1)! },
        sourceEventSeqs: oldNodes,
      })
      append('compaction/end', { compactionId: 'race-compact', turn: null })
      await plugin.buildAutoContext(session)
      await plugin.buildAutoContext(session)
      expect(session.deriveMessages()).toHaveLength(1)
      expect(JSON.stringify(session.deriveMessages())).toContain('Host retained summary')
      expect(JSON.stringify(session.deriveMessages())).not.toContain('[StrataGate conversation block]')
    } finally {
      release()
      await plugin.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps a ready Block in memory when every visible level is too large', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-skip-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-skip' as never)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-skip', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({ user: 'hi', assistant: 'done', threadId: String(session.id), createdAt: turnEndAt(session) })
      const before = [...session.surface.nodes]
      expect(replace(plugin, session, memory.listBlocks()[0]!, memory.getBlockContext(String(session.id))[0]!)).toBe(false)
      expect(session.surface.nodes).toEqual(before)
      expect(memory.listBlocks()[0]?.processingStatus).toBe('ready')
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('does not target an unrelated DSH turn when the Block has a different source time', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-turn-gap-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-turn-gap' as never)
    const user = 'This turn belongs to the host. '.repeat(150)
    appendTurn(session, user, 'Host answer. '.repeat(150))
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-turn-gap', blockTurnSize: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({
        user, assistant: 'Host answer. '.repeat(150), threadId: String(session.id),
        createdAt: new Date(Date.parse(turnEndAt(session)) - 60_000).toISOString(),
      })
      const before = [...session.surface.nodes]
      expect(replace(plugin, session, memory.listBlocks()[0]!, memory.getBlockContext(String(session.id))[0]!)).toBe(false)
      expect(session.surface.nodes).toEqual(before)
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('lets decay shrink a checkpoint and keeps user expansion available without surface inflation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-issue81-decay-'))
    const database = join(directory, 'memory.db')
    const session = Session.create('issue81-decay' as never)
    const user = 'Working through the project details. '.repeat(100)
    const assistant = 'The detailed project answer. '.repeat(100)
    appendTurn(session, user, assistant)
    const memory = await StrataGate.open({
      database, namespace: 'dsh:session:issue81-decay', blockTurnSize: 1, blockDecayLambda: 1,
      summarizer: models.summarizer, extractor: models.extractor,
    })
    const plugin = runtime(database)
    try {
      await memory.appendTurn({ user, assistant, threadId: String(session.id), createdAt: turnEndAt(session) })
      const block = memory.listBlocks()[0]!
      const fresh = memory.getBlockContext(String(session.id))[0]!
      const oldNodes = [...session.surface.nodes]
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: [
          '[StrataGate conversation block]', `Block: ${block.id}`, 'Turns: 1-1',
          'Level: L5 (L5 raw transcript)', '', fresh.content,
        ].join('\n') }],
        source: { kind: 'plugin', plugin: 'stratagate-memory' },
      }), {
        surfaceOp: { op: 'replace', startSeq: oldNodes[0]!, endSeq: oldNodes.at(-1)! },
        sourceEventSeqs: oldNodes,
      })
      const beforeDecay = estimateTokens(JSON.stringify(session.deriveMessages()))
      await memory.appendTurn({ user: 'Later turn', assistant: 'Later answer', threadId: String(session.id) })
      await memory.appendTurn({ user: 'Another turn', assistant: 'Another answer', threadId: String(session.id) })
      await memory.appendTurn({ user: 'Final turn', assistant: 'Final answer', threadId: String(session.id) })
      const decayed = memory.getBlockContext(String(session.id))
      expect(decayed[0]!.level).toBeLessThan(5)
      const sync = (plugin as unknown as { syncDecayedBlockSurface: (
        session: Session, memory: StrataGate, contexts: BlockContextEntry[],
      ) => boolean }).syncDecayedBlockSurface.bind(plugin)
      expect(sync(session, memory, decayed)).toBe(true)
      const afterDecay = estimateTokens(JSON.stringify(session.deriveMessages()))
      expect(afterDecay).toBeLessThan(beforeDecay * 0.9)
      await memory.expandBlock(block.id, 'L5', 'user')
      const expanded = memory.getBlockContext(String(session.id))
      expect(expanded[0]!.level).toBe(5)
      expect(sync(session, memory, expanded)).toBe(false)
      expect(estimateTokens(JSON.stringify(session.deriveMessages()))).toBe(afterDecay)
      expect(memory.listBlocks()[0]?.l5Raw[0]?.content).toBe(user)
    } finally {
      await plugin.close()
      await memory.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
