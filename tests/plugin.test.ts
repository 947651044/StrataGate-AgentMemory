import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import FileSettingsRuntime from '@deepseek-ai/dsh-settings-file'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'

describe('DSH plugin composition', () => {
  it('persists global chat display preferences across a complete plugin restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-display-settings-'))
    const settingsPath = join(directory, 'settings.json')
    const database = join(directory, 'memory.db')
    const mount = async () => {
      const ctx = new Context()
      await ctx.plugin(FileSettingsRuntime, { path: settingsPath, watch: false })
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(AgentDefaultModelConfig, { provider: 'test', model: 'test' })
      ctx.provide('webServer', { host: '127.0.0.1', port: 10259, register: () => () => {} })
      await ctx.plugin(plugin, { database })
      return ctx
    }
    let first: Context | undefined
    let restarted: Context | undefined
    try {
      first = await mount()
      const settings = first.get('settings')!
      await settings.update(plugin.STRATAGATE_SETTINGS_NAMESPACE, {
        showStrataGateStatus: false,
        showShortTermStatus: false,
        showRetrievalStatus: false,
      })
      expect(settings.get(plugin.STRATAGATE_SETTINGS_NAMESPACE)).toMatchObject({
        showStrataGateStatus: false,
        showShortTermStatus: false,
        showRetrievalStatus: false,
      })
      await first.fiber.dispose()
      first = undefined

      restarted = await mount()
      expect(restarted.get('settings')!.get(plugin.STRATAGATE_SETTINGS_NAMESPACE)).toMatchObject({
        showStrataGateStatus: false,
        showShortTermStatus: false,
        showRetrievalStatus: false,
      })
      const stored = JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(settingsPath, 'utf8')))
      expect(Object.keys(stored)).toEqual([plugin.STRATAGATE_SETTINGS_NAMESPACE])
    } finally {
      await first?.fiber.dispose()
      await restarted?.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each([
    ['auto', undefined],
    ['force-off', 'force-off'],
  ] as const)('registers the plugin settings entry with structured reasoning effort %s', async (expected, configured) => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-settings-'))
    const ctx = new Context()
    let registration: { namespace: unknown; entry: unknown } | undefined
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(AgentDefaultModelConfig, { provider: 'test', model: 'test' })
      ctx.provide('webServer', { host: '127.0.0.1', port: 10259, register: () => () => {} })
      ctx.provide('settings', {
        installSection: (...args: any[]) => {
          const [, namespace, , entry, hooks] = args
          registration = { namespace, entry }
          hooks.setSource(() => entry)
          hooks.onChange()
        },
      })
      await ctx.plugin(plugin, {
        database: join(directory, 'memory.db'),
        ...(configured ? { structuredReasoningEffort: configured } : {}),
      })

      expect(registration).toEqual({
        namespace: plugin.STRATAGATE_SETTINGS_NAMESPACE,
        entry: {
          structuredReasoningEffort: expected,
          showStrataGateStatus: true,
          showShortTermStatus: true,
          showRetrievalStatus: true,
        },
      })
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('loads into the official Cordis services and registers the complete memory protocol', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'stratagate-dsh-plugin-'))
    const ctx = new Context()
    try {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(SystemPrompt, {})
      await ctx.plugin(ToolRuntime, { mode: 'native' })
      await ctx.plugin(AgentDefaultModelConfig, { provider: 'test', model: 'test' })
      ctx.provide('webServer', { host: '127.0.0.1', port: 10259, register: () => () => {} })
      await ctx.plugin(plugin, { database: join(directory, 'memory.db') })

      const tools = ctx.tools.schemas()
      const names = tools.map(({ name }) => name)
      expect(names).toEqual([
        'memory_profile_update',
        'feedback_prepare',
        'memory_search_events',
        'memory_search_graph',
        'memory_expand_graph_node',
        'memory_search_elements',
        'memory_search_raw',
        'memory_get_blocks',
        'memory_expand_block',
        'memory_expand_event',
        'memory_expand_element',
        'memory_assess',
        'memory_record_use',
      ])
      for (const tool of tools) {
        expect(tool.description, tool.name).toMatch(/^This tool is provided by the StrataGate plugin\./)
      }
      const prompt = await ctx.systemPrompt.assemble()
      expect(prompt.sections).toContainEqual(expect.objectContaining({
        name: 'tool:stratagate-memory',
        text: expect.stringMatching(/StrataGate provides durable, evidence-gated memory[\s\S]*independent batch[\s\S]*batch_id/),
      }))
      expect(prompt.sections).toContainEqual(expect.objectContaining({
        name: 'tool:stratagate-feedback',
        text: expect.stringMatching(/clear error signal[\s\S]*at most one proactive feedback suggestion[\s\S]*namespace plus its substantive characteristics[\s\S]*feedback_prepare itself/),
      }))

      const conversationMessages: Array<{ id: string; role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }>; source: { kind: 'user' | 'model' } }> = []
      const session = {
        id: 'auto-context-session',
        header: { id: 'auto-context-session', version: 0, createdAt: 0, cwd: directory },
        snapshotEvents: () => [],
        eventAt: () => undefined,
        deriveMessages: () => conversationMessages,
      } as unknown as Session
      const steered: unknown[] = []
      const agent = {
        session,
        steer: (message: unknown) => steered.push(message),
      } as unknown as Agent
      const scopedPrompt = await ctx.systemPrompt.assemble({
        agent,
      })
      expect(scopedPrompt.contexts).toContainEqual(expect.objectContaining({
        name: 'stratagate:auto-memory',
        text: expect.stringContaining('[Activated long-term memory]'),
      }))
      expect(scopedPrompt.contexts.some((item) => item.name === 'stratagate:persistent-profile')).toBe(false)

      const search = ctx.tools.get('memory_search_events')
      const profileUpdate = ctx.tools.get('memory_profile_update')
      const feedbackPrepare = ctx.tools.get('feedback_prepare')
      const recordUse = ctx.tools.get('memory_record_use')
      expect(search).toBeDefined()
      expect(profileUpdate).toBeDefined()
      expect(profileUpdate!.description).toContain('Only a directly subsequent "同意" authorizes that single proposed change')
      conversationMessages.push({ id: 'profile-user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后默认都用中文回复。' }] })
      expect(await profileUpdate!.execute({ field: 'preferredLanguage', value: '中文' }, { agent, callId: 'profile-call' } as never))
        .toEqual({ field: 'preferredLanguage', value: '中文', modified: true })
      expect(await profileUpdate!.execute({ field: 'preferredLanguage', value: '中文' }, { agent, callId: 'profile-call-2' } as never))
        .toEqual({ field: 'preferredLanguage', value: '中文', modified: false })
      const nextPrompt = await ctx.systemPrompt.assemble({ agent })
      expect(nextPrompt.contexts).toContainEqual(expect.objectContaining({ name: 'stratagate:persistent-profile', text: expect.stringContaining('Preferred language: 中文') }))
      expect(nextPrompt.contexts.find((item) => item.name === 'stratagate:persistent-profile')?.text).not.toContain('User background:')
      conversationMessages.push({ id: 'profile-user-refusal', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '不同意' }] })
      await expect(profileUpdate!.execute({ field: 'responsePreferences', value: '回答简洁' }, { agent, callId: 'profile-refusal' } as never))
        .rejects.toThrow(/explicit current user request/)
      conversationMessages.push({ id: 'profile-user-partial', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后默认用英文' }] })
      await expect(profileUpdate!.execute({ field: 'preferredLanguage', value: '英' }, { agent, callId: 'profile-partial-direct' } as never))
        .rejects.toThrow(/explicit current user request/)
      await expect(profileUpdate!.execute({ field: 'persistentNotes', value: '英文' }, { agent, callId: 'profile-wrong-field' } as never))
        .rejects.toThrow(/explicit current user request/)
      conversationMessages.push({ id: 'profile-user-negative', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后不要用英文' }] })
      await expect(profileUpdate!.execute({ field: 'preferredLanguage', value: '英文' }, { agent, callId: 'profile-negative-language' } as never))
        .rejects.toThrow(/explicit current user request/)
      conversationMessages.push({ id: 'profile-user-negative-name', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后不叫我橙子' }] })
      await expect(profileUpdate!.execute({ field: 'userPreferredName', value: '橙子' }, { agent, callId: 'profile-negative-name' } as never))
        .rejects.toThrow(/explicit current user request/)
      conversationMessages.push({ id: 'profile-user-fact', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我的职业是工程师' }] })
      await expect(profileUpdate!.execute({ field: 'userBackground', value: '工程师' }, { agent, callId: 'profile-fact' } as never))
        .rejects.toThrow(/explicit current user request/)
      conversationMessages.push({ id: 'profile-user-name', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后叫我橙子' }] })
      expect(await profileUpdate!.execute({ field: 'userPreferredName', value: '橙子' }, { agent, callId: 'profile-name' } as never))
        .toMatchObject({ modified: true })
      conversationMessages.push({ id: 'profile-user-assistant-name', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我希望你以后叫小橙' }] })
      expect(await profileUpdate!.execute({ field: 'assistantPreferredName', value: '小橙' }, { agent, callId: 'profile-assistant-name' } as never))
        .toMatchObject({ modified: true })
      conversationMessages.push({ id: 'profile-user-instruction', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '以后技术讨论不要一味顺着我' }] })
      expect(await profileUpdate!.execute({ field: 'standingInstructions', value: '以后技术讨论不要一味顺着我' }, { agent, callId: 'profile-instruction' } as never))
        .toMatchObject({ modified: true })
      conversationMessages.push({ id: 'profile-assistant-partial', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '要将 preferredLanguage 改为“英文”吗？请回复“同意”。' }] })
      conversationMessages.push({ id: 'profile-user-partial-consent', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '同意' }] })
      await expect(profileUpdate!.execute({ field: 'preferredLanguage', value: '英' }, { agent, callId: 'profile-partial-consent' } as never))
        .rejects.toThrow(/direct subsequent 同意/)
      conversationMessages.push({ id: 'profile-assistant-multi', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '要将 preferredLanguage 改为“英文”，将 responsePreferences 改为“简洁”吗？请回复“同意”。' }] })
      conversationMessages.push({ id: 'profile-user-multi', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '同意' }] })
      await expect(profileUpdate!.execute({ field: 'preferredLanguage', value: '英文' }, { agent, callId: 'profile-multi-consent' } as never))
        .rejects.toThrow(/direct subsequent 同意/)
      conversationMessages.push({ id: 'profile-assistant-proposal', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '要将 responsePreferences（回复方式和风格偏好）改为“回答简洁”吗？如果同意，请回复“同意”。' }] })
      conversationMessages.push({ id: 'profile-user-2', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '同意' }] })
      expect(await profileUpdate!.execute({ field: 'responsePreferences', value: '回答简洁' }, { agent, callId: 'profile-call-3' } as never))
        .toMatchObject({ modified: true })
      await expect(profileUpdate!.execute({ field: 'standingInstructions', value: '回答简洁' }, { agent, callId: 'profile-call-4' } as never))
        .rejects.toThrow(/already authorized/)
      conversationMessages.push({ id: 'profile-assistant-proposal-2', role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: '要将 longTermGoals（长期目标）改为“学习中文”吗？如果同意，请回复“同意”。' }] })
      conversationMessages.push({ id: 'profile-user-3', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '同意' }] })
      await expect(profileUpdate!.execute({ field: 'standingInstructions', value: '学习中文' }, { agent, callId: 'profile-call-5' } as never))
        .rejects.toThrow(/direct subsequent 同意/)
      expect(feedbackPrepare).toBeDefined()
      expect(recordUse).toBeDefined()
      expect(feedbackPrepare!.description).toMatch(/directly requests it[\s\S]*explicitly agrees/)
      expect(feedbackPrepare!.description).toMatch(/current conversation[\s\S]*Never submit anything to GitHub/)
      expect(feedbackPrepare!.description).toMatch(/draft is local and not submitted[\s\S]*feedbackUrl[\s\S]*打开反馈草稿/)
      expect(feedbackPrepare!.description).toContain('要不要顺便让我尝试修复这个问题，并提交一个 PR？')
      expect(feedbackPrepare!.description).toMatch(/ask exactly once[\s\S]*does not respond or declines, do not ask again/)
      const feedback = await feedbackPrepare!.execute({
        title: 'Local draft',
        description: 'A real failure from this conversation.',
        reproduction: ['Run the failing StrataGate action.'],
      }, {
        agent,
        callId: 'feedback-call',
      } as never) as unknown as Record<string, unknown>
      expect(feedback).toMatchObject({
        prepared: true,
        draftCreated: true,
        submitted: false,
        feedbackUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:10259\/\?settings=stratagate-memory&stratagateView=feedback/),
      })
      expect(feedback).not.toHaveProperty('draft')
      expect(feedback.feedbackUrl).not.toContain('github.com')
      await search!.execute({ query: 'nothing stored' }, {
        agent,
        callId: 'search-call',
      } as never)
      await ctx.serial('agent/turn-stopping', {
        agent,
        turn: 1,
        signal: new AbortController().signal,
      })
      expect(steered).toHaveLength(1)
      expect(steered[0]).toMatchObject({
        source: { kind: 'plugin', plugin: 'stratagate-memory', form: 'instructions' },
      })

      await recordUse!.execute({ evidence_refs: [] }, {
        agent,
        callId: 'record-use-call',
      } as never)
      await ctx.serial('agent/turn-stopping', {
        agent,
        turn: 1,
        signal: new AbortController().signal,
      })
      expect(steered).toHaveLength(1)
    } finally {
      await ctx.fiber.dispose()
      await rm(directory, { recursive: true, force: true })
    }
  })
})
