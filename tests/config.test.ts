import { describe, expect, it } from 'vitest'
import { Config, resolveConfig } from '../src/config.js'

describe('DeepSeek Harness plugin config', () => {
  it('resolves safe defaults', () => {
    expect(resolveConfig({ database: ' ./memory.db ' })).toEqual({
      database: './memory.db',
      namespaceMode: 'project',
      namespacePrefix: 'dsh',
      globalNamespace: 'global',
      blockTurnSize: 6,
      blockDecayLambda: 0.3,
      ingestSubagents: false,
      agentMemoryEnabled: true,
      agentMemoryDecayPerHour: 0.7,
      agentMemoryArchiveThreshold: 0.05,
      agentMemoryMaxActive: 64,
      maxOutputTokens: 2048,
      structuredTaskTimeoutMs: 120000,
      structuredReasoningEffort: 'auto',
      showStrataGateStatus: true,
      showShortTermStatus: true,
      showRetrievalStatus: true,
    })
  })

  it('requires an explicit model pair', () => {
    expect(() => resolveConfig({ database: 'memory.db', provider: 'deepseek' }))
      .toThrow('provider and model must be configured together')
  })

  it('exposes the Block decay coefficient and guidance in the plugin form', () => {
    const field = Config.dict?.blockDecayLambda
    expect(field?.meta).toMatchObject({
      default: 0.3,
      min: 0,
      step: 0.05,
      description: 'Block 衰减系数 λ',
      comment: '默认 0.3；数字越小，记忆遗忘越慢，消耗 token 越多，不建议大于 0.4。',
    })
    expect(resolveConfig({ database: 'memory.db', blockDecayLambda: 0.15 }).blockDecayLambda).toBe(0.15)
  })

  it('exposes agent memory knobs with safe defaults and clamps', () => {
    expect(Config.dict?.agentMemoryEnabled?.meta).toMatchObject({ default: true })
    expect(Config.dict?.agentMemoryDecayPerHour?.meta).toMatchObject({ default: 0.7, min: 0 })
    expect(Config.dict?.agentMemoryArchiveThreshold?.meta).toMatchObject({ default: 0.05, min: 0, max: 1 })
    expect(Config.dict?.agentMemoryMaxActive?.meta).toMatchObject({ default: 64, min: 1 })
    expect(resolveConfig({ database: 'memory.db' })).toMatchObject({
      agentMemoryEnabled: true,
      agentMemoryDecayPerHour: 0.7,
      agentMemoryArchiveThreshold: 0.05,
      agentMemoryMaxActive: 64,
    })
    expect(resolveConfig({
      database: 'memory.db',
      agentMemoryEnabled: false,
      agentMemoryDecayPerHour: -2,
      agentMemoryArchiveThreshold: 7,
      agentMemoryMaxActive: 0.4,
    })).toMatchObject({
      agentMemoryEnabled: false,
      agentMemoryDecayPerHour: 0,
      agentMemoryArchiveThreshold: 1,
      agentMemoryMaxActive: 1,
    })
  })

  it('resolves the structured reasoning effort policy with a safe default', () => {
    expect(resolveConfig({ database: 'memory.db' }).structuredReasoningEffort).toBe('auto')
    expect(resolveConfig({
      database: 'memory.db',
      structuredReasoningEffort: 'force-off',
    }).structuredReasoningEffort).toBe('force-off')
  })

  it('exposes persistent defaults for all chat display preferences', () => {
    expect(Config.dict?.showStrataGateStatus?.meta).toMatchObject({ default: true })
    expect(Config.dict?.showShortTermStatus?.meta).toMatchObject({ default: true })
    expect(Config.dict?.showRetrievalStatus?.meta).toMatchObject({ default: true })
    expect(resolveConfig({ database: 'memory.db' })).toMatchObject({
      showStrataGateStatus: true,
      showShortTermStatus: true,
      showRetrievalStatus: true,
    })
    expect(resolveConfig({
      database: 'memory.db',
      showStrataGateStatus: false,
      showShortTermStatus: false,
      showRetrievalStatus: false,
    })).toMatchObject({
      showStrataGateStatus: false,
      showShortTermStatus: false,
      showRetrievalStatus: false,
    })
  })
})
