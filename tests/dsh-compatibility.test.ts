import { describe, expect, it } from 'vitest'
import {
  buildDshReplaceSurfaceOp,
  buildDshMessageSource,
  classifyDshRuntime,
  type DshRuntimePackageVersions,
} from '../src/dsh-compatibility.js'

const common = {
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/schemastery': '3.18.2',
} as const

function versions(version: '0.1.2-rc.1' | '0.1.5-rc.2' | '0.1.6-alpha.1' | '0.1.7-rc.1'): DshRuntimePackageVersions {
  return {
    ...common,
    ...(version === '0.1.7-rc.1' ? { '@deepseek-ai/cordis': '4.0.4', '@deepseek-ai/schemastery': '3.18.4' } : {}),
    '@deepseek-ai/dsh-agent-default-model': version,
    '@deepseek-ai/dsh-client-ui-conversation': version,
    '@deepseek-ai/dsh-llm': version,
    '@deepseek-ai/dsh-native-command': version,
    '@deepseek-ai/dsh-session': version,
    '@deepseek-ai/dsh-settings': version,
    '@deepseek-ai/dsh-system-prompt': version,
    '@deepseek-ai/dsh-tools': version,
  }
}

describe('DSH runtime compatibility', () => {
  it('accepts the complete 0.1.2 host family', () => {
    expect(classifyDshRuntime(versions('0.1.2-rc.1')).cliVersion).toBe('0.1.2-rc.1')
  })

  it('accepts the real 0.1.5-rc.1 dependency tree at rc.2', () => {
    expect(classifyDshRuntime(versions('0.1.5-rc.2')).cliVersion).toBe('0.1.5-rc.1')
  })

  it('accepts the complete 0.1.6-alpha.1 host family', () => {
    expect(classifyDshRuntime(versions('0.1.6-alpha.1')).cliVersion).toBe('0.1.6-alpha.1')
  })

  it('accepts the actual 0.1.7-rc.1 host family', () => {
    expect(classifyDshRuntime(versions('0.1.7-rc.1')).cliVersion).toBe('0.1.7-rc.1')
  })

  it('rejects a 0.1.5-rc.2 dependency family mixed with dsh-session 0.1.2-rc.1', () => {
    const mixed = { ...versions('0.1.5-rc.2'), '@deepseek-ai/dsh-session': '0.1.2-rc.1' }
    expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(mixed)).toThrow(/dsh-session@0\.1\.2-rc\.1/)
  })

  it('rejects a mixed 0.1.5/0.1.6 profile-local DSH runtime with a clear diagnostic', () => {
    const mixed = { ...versions('0.1.6-alpha.1'), '@deepseek-ai/dsh-session': '0.1.5-rc.2' }
    expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(mixed)).toThrow(/dsh-session@0\.1\.5-rc\.2/)
  })

  it('rejects a host family that is missing a required package', () => {
    const missing = { ...versions('0.1.6-alpha.1'), '@deepseek-ai/dsh-tools': '<missing>' }
    expect(() => classifyDshRuntime(missing)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(missing)).toThrow(/dsh-tools@<missing>/)
  })

  it('rejects a mixed native-command runtime', () => {
    const mixed = { ...versions('0.1.7-rc.1'), '@deepseek-ai/dsh-native-command': '0.1.6-alpha.1' }
    expect(() => classifyDshRuntime(mixed)).toThrow(/unsupported or mixed core runtime/)
    expect(() => classifyDshRuntime(mixed)).toThrow(/dsh-native-command@0\.1\.6-alpha\.1/)
  })

  it('uses the producer-owned source kind only for DSH 0.1.7', () => {
    expect(buildDshMessageSource('0.1.6-alpha.1')).toEqual({ kind: 'plugin', plugin: 'stratagate-memory' })
    expect(buildDshMessageSource('0.1.7-rc.1')).toEqual({ kind: 'plugin:stratagate-memory' })
    expect(buildDshMessageSource('0.1.7-rc.1', 'instructions')).toEqual({ kind: 'plugin:stratagate-memory', form: 'instructions' })
  })

  it('uses each host version\'s native surface replacement shape', () => {
    expect(buildDshReplaceSurfaceOp('0.1.2-rc.1', 2, 5)).toEqual({ op: 'replace', start: 2, end: 5 })
    expect(buildDshReplaceSurfaceOp('0.1.5-rc.2', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
    expect(buildDshReplaceSurfaceOp('0.1.6-alpha.1', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
    expect(buildDshReplaceSurfaceOp('0.1.7-rc.1', 2, 5)).toEqual({ op: 'replace', startSeq: 2, endSeq: 5 })
  })
})
