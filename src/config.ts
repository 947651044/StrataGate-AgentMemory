import z from '@deepseek-ai/schemastery'

export type NamespaceMode = 'project' | 'session' | 'global'
export type StructuredReasoningEffortMode = 'auto' | 'force-off'

export interface Config {
  database?: string
  sessionRoot?: string
  namespaceMode?: NamespaceMode
  namespacePrefix?: string
  globalNamespace?: string
  blockTurnSize?: number
  blockDecayLambda?: number
  ingestSubagents?: boolean
  agentMemoryEnabled?: boolean
  agentMemoryDecayPerHour?: number
  agentMemoryArchiveThreshold?: number
  agentMemoryMaxActive?: number
  provider?: string
  model?: string
  maxOutputTokens?: number
  structuredTaskTimeoutMs?: number
  structuredReasoningEffort?: StructuredReasoningEffortMode
  showStrataGateStatus?: boolean
  showShortTermStatus?: boolean
  showRetrievalStatus?: boolean
}

export interface ResolvedConfig {
  database: string
  sessionRoot?: string
  namespaceMode: NamespaceMode
  namespacePrefix: string
  globalNamespace: string
  blockTurnSize: number
  blockDecayLambda: number
  ingestSubagents: boolean
  agentMemoryEnabled?: boolean
  agentMemoryDecayPerHour?: number
  agentMemoryArchiveThreshold?: number
  agentMemoryMaxActive?: number
  provider?: string
  model?: string
  maxOutputTokens: number
  structuredTaskTimeoutMs?: number
  structuredReasoningEffort?: StructuredReasoningEffortMode
  showStrataGateStatus?: boolean
  showShortTermStatus?: boolean
  showRetrievalStatus?: boolean
}

export interface StructuredReasoningEffortSettings {
  structuredReasoningEffort: StructuredReasoningEffortMode
  showStrataGateStatus: boolean
  showShortTermStatus: boolean
  showRetrievalStatus: boolean
}

export const StructuredReasoningEffortSettings: z<StructuredReasoningEffortSettings> = z.object({
  structuredReasoningEffort: z.union(['auto', 'force-off'] as const).default('auto')
    .description('记忆处理结构化调用的推理档位策略')
    .comment('auto：仅在模型明确支持 off 时使用；force-off：优先使用 off，不支持或能力检查失败时安全降级，并对同一模型只告警一次。'),
  showStrataGateStatus: z.boolean().default(true)
    .description('显示 StrataGate 状态提示')
    .comment('关闭后隐藏聊天界面中的 StrataGate 状态信息；记忆、检索和后台处理不受影响。'),
  showShortTermStatus: z.boolean().default(true)
    .description('显示短期记忆块状态')
    .comment('控制短期记忆块进度、Block 封存与整理状态的聊天内提示；后台处理不受影响。'),
  showRetrievalStatus: z.boolean().default(true)
    .description('显示记忆检索状态')
    .comment('控制检索次数、返回数量和记忆采用信息的聊天内提示；检索与采用不受影响。'),
})

export const Config: z<Config> = z.object({
  database: z.string().required(),
  sessionRoot: z.string(),
  namespaceMode: z.union(['project', 'session', 'global'] as const).default('project'),
  namespacePrefix: z.string().default('dsh'),
  globalNamespace: z.string().default('global'),
  blockTurnSize: z.natural().min(1).default(6),
  blockDecayLambda: z.number().step(0.05).min(0).default(0.3)
    .description('Block 衰减系数 λ')
    .comment('默认 0.3；数字越小，记忆遗忘越慢，消耗 token 越多，不建议大于 0.4。'),
  ingestSubagents: z.boolean().default(false),
  agentMemoryEnabled: z.boolean().default(true)
    .description('启用 agent 主动记忆（memory_remember）')
    .comment('开启后 agent 可以在会话中主动记录值得记忆的事实；仅当前会话有效，不跨会话共享。'),
  agentMemoryDecayPerHour: z.number().step(0.05).min(0).default(0.7)
    .description('主动记忆衰减系数 λ（每小时）')
    .comment('权重 = exp(-λ × 距上次强化的小时数)；默认 0.7（半衰期约 1 小时）。数字越小遗忘越慢。'),
  agentMemoryArchiveThreshold: z.number().step(0.05).min(0).max(1).default(0.05)
    .description('主动记忆归档阈值')
    .comment('权重低于该值时标记为 archived：不再参与检索与自动注入，但可在管理面板查看，不会被删除。'),
  agentMemoryMaxActive: z.natural().min(1).default(64)
    .description('每个会话的主动记忆上限')
    .comment('活跃条数达到上限后，新记录会归档权重最低的旧条目。'),
  provider: z.string(),
  model: z.string(),
  maxOutputTokens: z.natural().min(256).default(2_048),
  structuredTaskTimeoutMs: z.natural().min(1_000).default(120_000),
  structuredReasoningEffort: z.union(['auto', 'force-off'] as const).default('auto'),
  showStrataGateStatus: z.boolean().default(true),
  showShortTermStatus: z.boolean().default(true),
  showRetrievalStatus: z.boolean().default(true),
})

export function resolveConfig(config: Config): ResolvedConfig {
  const database = config.database?.trim() ?? ''
  const sessionRoot = config.sessionRoot?.trim()
  const namespacePrefix = config.namespacePrefix?.trim() || 'dsh'
  const globalNamespace = config.globalNamespace?.trim() || 'global'
  const provider = config.provider?.trim()
  const model = config.model?.trim()
  if (!database) throw new TypeError('StrataGate database path must not be empty')
  if (Boolean(provider) !== Boolean(model)) {
    throw new TypeError('StrataGate provider and model must be configured together')
  }
  return {
    database,
    ...(sessionRoot ? { sessionRoot } : {}),
    namespaceMode: config.namespaceMode ?? 'project',
    namespacePrefix,
    globalNamespace,
    blockTurnSize: Math.max(1, Math.floor(config.blockTurnSize ?? 6)),
    blockDecayLambda: Math.max(0, config.blockDecayLambda ?? 0.3),
    ingestSubagents: config.ingestSubagents ?? false,
    agentMemoryEnabled: config.agentMemoryEnabled ?? true,
    agentMemoryDecayPerHour: Math.max(0, config.agentMemoryDecayPerHour ?? 0.7),
    agentMemoryArchiveThreshold: Math.min(1, Math.max(0, config.agentMemoryArchiveThreshold ?? 0.05)),
    agentMemoryMaxActive: Math.max(1, Math.floor(config.agentMemoryMaxActive ?? 64)),
    ...(provider && model ? { provider, model } : {}),
    maxOutputTokens: Math.max(256, Math.floor(config.maxOutputTokens ?? 2_048)),
    structuredTaskTimeoutMs: Math.max(1_000, Math.floor(config.structuredTaskTimeoutMs ?? 120_000)),
    structuredReasoningEffort: config.structuredReasoningEffort ?? 'auto',
    showStrataGateStatus: config.showStrataGateStatus ?? true,
    showShortTermStatus: config.showShortTermStatus ?? true,
    showRetrievalStatus: config.showRetrievalStatus ?? true,
  }
}
