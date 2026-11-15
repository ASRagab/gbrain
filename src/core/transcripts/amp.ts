import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { TRANSCRIPT_EXPORT_JSON_HARD_CAP, type TranscriptAdapter, type TranscriptMessage } from './types.ts';

const blockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  hidden: z.boolean().optional(),
});
const exportSchema = z.object({
  id: z.string().regex(/^T-[0-9a-f-]+$/i),
  created: z.number().finite(),
  title: z.string().optional(),
  messages: z.array(z.object({
    role: z.string(),
    createdAt: z.string().optional(),
    content: z.array(blockSchema),
  })),
});

export const ampAdapter: TranscriptAdapter = {
  format: 'amp-export',
  specTarget: {
    id: 'amp-export-2026-11', status: 'verified', verifiedAt: '2026-11-15',
    references: ['amp threads export --help', 'amp threads export (live JSON shape inspection)'],
    note: 'Single thread object; created is epoch milliseconds, message createdAt is ISO. Hidden text is injected context, not a human turn.',
  },
  detect(path, sample) {
    const head = sample.toString('utf8');
    return path.endsWith('.json') && /"id"\s*:\s*"T-[0-9a-f-]+"/i.test(head)
      && /"messages"\s*:/.test(head);
  },
  async *parse(path, opts = {}) {
    const bytesRead = statSync(path).size;
    if (bytesRead > (opts.maxBytes ?? TRANSCRIPT_EXPORT_JSON_HARD_CAP)) {
      throw new Error('Amp export exceeds byte cap; no partial conversation imported');
    }
    const thread = exportSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    const startedAt = new Date(thread.created).toISOString();
    const messages: TranscriptMessage[] = [];
    for (const row of thread.messages) {
      if (row.role !== 'user' && row.role !== 'assistant') continue;
      const text = row.content.filter(b => b.type === 'text' && !b.hidden)
        .map(b => b.text ?? '').join('\n').trim();
      if (!text) continue;
      if (!row.createdAt || !Number.isFinite(Date.parse(row.createdAt))) {
        throw new Error('Amp text message is missing a valid source timestamp');
      }
      messages.push({ role: row.role, timestamp: new Date(row.createdAt).toISOString(), text });
    }
    if (messages.length) {
      yield {
        meta: { harness: 'amp-export', sessionId: thread.id, startedAt, title: thread.title,
          raw: { thread_id: thread.id, source_url: `https://ampcode.com/threads/${thread.id}` } },
        messages,
      };
    }
    return { bytesRead, skippedLines: 0, truncated: false, sessions: messages.length ? 1 : 0,
      expectedEmpty: messages.length === 0,
      userTurnsMissing: messages.length > 0 && !messages.some(m => m.role === 'user'),
      zeroSessionsReason: messages.length ? undefined : 'no visible user/assistant text' };
  },
};
