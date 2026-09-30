import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as store from './db.js';
import { buildConversationReport } from '../shared/report.js';
import { DomainError } from './validation.js';

export function registerReportRoutes(app: FastifyInstance, owner: (request: FastifyRequest) => string) {
  app.post<{ Params: { id: string } }>('/api/projects/:id/reports', async (request, reply) => {
    const ownerId = owner(request);
    const result = store.db.transaction(() => {
      const branch = store.getBranch(ownerId, request.params.id);
      if (!branch) throw new DomainError('not_found', 'Conversation not found', 404);
      const transcript = store.speechSegmentsFor(ownerId, request.params.id);
      if (!branch.snapshot.field && !transcript.length) throw new DomainError('empty_conversation', 'Start a conversation before exporting.', 400);
      const active = store.db.prepare('SELECT id FROM sessions WHERE owner_id=? AND project_id=? AND ended_at IS NULL AND expires_at>? LIMIT 1').get(ownerId, request.params.id, store.now());
      const report = buildConversationReport(branch.snapshot.field, transcript, store.now(), Boolean(active));
      const id = store.saveConversationReport(ownerId, request.params.id, report);
      return { id, url: `/report/${id}` };
    })();
    return reply.code(201).header('Cache-Control', 'private, no-store').send(result);
  });
  app.get<{ Params: { id: string } }>('/api/reports/:id', async (request, reply) => {
    const report = store.getConversationReport(owner(request), request.params.id);
    if (!report) throw new DomainError('not_found', 'Report not found', 404);
    return reply.header('Cache-Control', 'private, no-store').send({ report });
  });
}
