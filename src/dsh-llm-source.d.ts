import type { ContextFormed } from '@deepseek-ai/dsh-llm'

// DSH 0.1.7 moved producer identities out of the core vocabulary. Declare
// StrataGate's producer-owned kind so V4 codec validation accepts new events.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:stratagate-memory': { kind: 'plugin:stratagate-memory' } & ContextFormed
  }
}
