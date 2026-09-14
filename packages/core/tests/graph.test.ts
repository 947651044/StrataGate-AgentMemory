import { describe, expect, it } from 'vitest';
import { StrataGate, type PersistentStrataGateOptions } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite.js';
import { normalizeSnapshot } from '../src/storage.js';

describe('Event-backed knowledge graph', () => {
  it('projects stable nodes and directed edges while keeping Event as source of truth', async () => {
    let sequence = 0;
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'event', l0Tags: [], l1Summary: 'event', l2Keypoints: [], shouldExtract: true }),
      idFactory: (prefix) => `${prefix}_${++sequence}`,
      graphIdFactory: (prefix) => `${prefix}_${++sequence}`,
      extractor: async ({ target }) => ({
        shouldExtract: true,
        reason: 'durable event',
        events: [{
          title: '发布 StrataGate',
          summary: 'chenhw7 使用 npm 发布 StrataGate。',
          sourceMessageIds: [target.l5Raw[0]!.id],
          sourceBlockId: target.id,
          temporal: { eventType: '版本发布', status: 'occurred', participants: ['chenhw7', 'StrataGate', 'npm'] },
        }],
      }),
      graphProjector: async ({ events }) => ({
        reason: 'projected',
        nodes: [
          { ref: 'person', name: 'chenhw7', type: 'person', tags: ['developer'], sourceEventIds: [events[0]!.id] },
          { ref: 'project', name: 'StrataGate', type: 'project', tags: ['memory-plugin', 'dsh-plugin'], aliases: ['strata_gate'], state: '已发布', sourceEventIds: [events[0]!.id] },
          { ref: 'tool', name: 'npm', type: 'tool', tags: ['package-manager'], sourceEventIds: [events[0]!.id] },
        ],
        edges: [
          { fromRef: 'person', toRef: 'project', relation: '贡献', sourceEventIds: [events[0]!.id], confidence: 0.95 },
          { fromRef: 'project', toRef: 'tool', relation: '使用', sourceEventIds: [events[0]!.id], confidence: 0.9 },
        ],
      }),
    });

    await memory.appendTurn({ user: '发布项目', assistant: '完成' });
    await memory.appendTurn({ user: '继续', assistant: '好的' });

    expect(memory.listElements()).toEqual([]);
    expect(memory.listGraphNodes()).toHaveLength(3);
    expect(memory.listGraphEdges()).toHaveLength(2);
    expect(memory.listGraphEdges()[0]).toMatchObject({ relation: '贡献', status: 'active', confidence: 0.95 });
    expect(memory.listEvents()[0]?.temporal).toMatchObject({
      eventType: 'release',
      status: 'occurred',
      participantNodeIds: expect.arrayContaining(memory.listGraphNodes().map(({ id }) => id)),
    });
    expect(memory.listGraphNodes().every((node) => node.sourceEventIds.includes(memory.listEvents()[0]!.id))).toBe(true);
    expect(memory.listGraphNodes().find(({ name }) => name === 'StrataGate')?.tags).toEqual(['memory-plugin', 'dsh-plugin']);
    expect((await memory.searchGraphNodes('memory-plugin'))[0]?.node.name).toBe('StrataGate');
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ status: 'completed', projectorVersion: 1, attempts: 1 });
  });

  it('persists failed projection progress for retry without requeueing completed Events', async () => {
    let attempts = 0;
    let now = new Date('2026-09-14T00:00:00.000Z');
    const storage = new SqliteStorage({ filename: ':memory:' });
    const options: PersistentStrataGateOptions = {
      storage,
      namespace: 'graph:test',
      blockTurnSize: 1,
      now: () => now,
      summarizer: async () => ({ l0Title: 'event', l0Tags: [], l1Summary: 'event', l2Keypoints: [], shouldExtract: true }),
      extractor: async ({ target }) => ({
        shouldExtract: true, reason: 'event', events: [{
          title: '迁移', summary: '迁移图谱', sourceMessageIds: [target.l5Raw[0]!.id], sourceBlockId: target.id,
          temporal: { eventType: 'migration' },
        }],
      }),
      graphProjector: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('rate limited');
        return { reason: 'empty but completed', nodes: [], edges: [] };
      },
    };
    const memory = await StrataGate.openWithStorage(options);
    await memory.appendTurn({ user: 'a', assistant: 'b' });
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({
      status: 'failed', attempts: 1, lastError: 'rate limited', nextRetryAt: '2026-09-14T08:00:01.000+08:00',
    });

    const restored = await StrataGate.openWithStorage(options);
    expect(restored.listGraphProjectionJobs()).toHaveLength(1);
    await restored.resumePendingWork();
    expect(attempts).toBe(1);
    now = new Date(now.getTime() + 1_000);
    await restored.resumePendingWork();
    expect(restored.listGraphProjectionJobs()[0]).toMatchObject({ status: 'completed', attempts: 2 });
    await restored.resumePendingWork();
    expect(attempts).toBe(2);
    await restored.close();
  });

  it('bounds automatic retries and always serves pending Graph work before failed retries', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      now: () => now,
      summarizer: async () => ({ l0Title: 'ready', l0Tags: [], l1Summary: 'ready', l2Keypoints: [], shouldExtract: false }),
      graphProjector: async () => ({ reason: 'unused', nodes: [], edges: [] }),
    });
    await memory.appendTurn({ user: 'source', assistant: 'stored' });
    const block = memory.listBlocks()[0]!;
    const firstEvent = await memory.addEvent({
      title: 'First', summary: 'Fails permanently.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    });
    const firstClaim = await memory.claimNextGraphProjection();
    expect(firstClaim?.events.map(({ id }) => id)).toEqual([firstEvent.id]);
    await memory.failGraphProjection(firstClaim!.jobId, new Error('permanent failure'));
    expect(await memory.claimNextGraphProjection()).toBeNull();
    const legacySnapshot = memory.exportSnapshot();
    delete (legacySnapshot.graphProjectionJobs[0] as { nextRetryAt?: string | null }).nextRetryAt;
    expect(normalizeSnapshot(legacySnapshot).graphProjectionJobs[0]?.nextRetryAt).toBeNull();

    now = new Date(now.getTime() + 1_000);
    const pendingEvent = await memory.addEvent({
      title: 'Pending', summary: 'Must not starve.', sourceBlockId: block.id, sourceMessageIds: [block.l5Raw[0]!.id],
    });
    const pendingClaim = await memory.claimNextGraphProjection();
    expect(pendingClaim?.events.map(({ id }) => id)).toEqual([pendingEvent.id]);
    await memory.completeGraphProjection(pendingClaim!.jobId, { reason: 'done', nodes: [], edges: [] });

    const secondClaim = await memory.claimNextGraphProjection();
    expect(secondClaim?.jobId).toBe(firstClaim?.jobId);
    await memory.failGraphProjection(secondClaim!.jobId, new Error('permanent failure'));
    now = new Date(now.getTime() + 2_000);
    const thirdClaim = await memory.claimNextGraphProjection();
    expect(thirdClaim?.jobId).toBe(firstClaim?.jobId);
    await memory.failGraphProjection(thirdClaim!.jobId, new Error('permanent failure'));

    now = new Date(now.getTime() + 60_000);
    expect(await memory.claimNextGraphProjection()).toBeNull();
    expect(memory.listGraphProjectionJobs().find(({ id }) => id === firstClaim?.jobId)).toMatchObject({
      status: 'failed', attempts: 3, nextRetryAt: null, lastError: 'permanent failure',
    });
    const exhausted = memory.listGraphProjectionJobs().find(({ id }) => id === firstClaim?.jobId)!;
    exhausted.status = 'pending';
    exhausted.attempts = 125;
    exhausted.nextRetryAt = '2020-01-01T00:00:00.000Z';
    expect(await memory.claimNextGraphProjection()).toBeNull();
  });

  it('manually retries only the selected failed Graph projection', async () => {
    let shouldFail = true;
    let calls = 0;
    const memory = StrataGate.inMemory({
      blockTurnSize: 1,
      summarizer: async () => ({ l0Title: 'event', l0Tags: [], l1Summary: 'event', l2Keypoints: [], shouldExtract: true }),
      extractor: async ({ target }) => ({
        shouldExtract: true,
        reason: 'event',
        events: [{ title: 'Graph retry', summary: 'Retry this graph batch.', sourceMessageIds: [target.l5Raw[0]!.id], sourceBlockId: target.id }],
      }),
      graphProjector: async () => {
        calls += 1;
        if (shouldFail) throw new Error('graph timed out');
        return { reason: 'completed', nodes: [], edges: [] };
      },
    });

    await memory.appendTurn({ user: 'graph', assistant: 'saved' });
    const jobId = memory.listGraphProjectionJobs()[0]!.id;
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ status: 'failed', attempts: 1 });

    shouldFail = false;
    const [first, second] = await Promise.all([
      memory.retryGraphProjection(jobId),
      memory.retryGraphProjection(jobId),
    ]);
    expect(first).toEqual({ nodeIds: [], edgeIds: [] });
    expect(second).toEqual(first);
    expect(calls).toBe(2);
    expect(memory.listGraphProjectionJobs()[0]).toMatchObject({ id: jobId, status: 'completed', attempts: 1, lastError: null });
  });
});
