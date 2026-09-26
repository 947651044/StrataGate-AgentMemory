import type { ContextFormed } from '@deepseek-ai/dsh-llm'

// DSH 0.1.7 moved producer identities out of the core vocabulary. Keep the
// identity already stored in StrataGate's older Session events.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    plugin: { kind: 'plugin'; plugin: string } & ContextFormed
  }
}
