import type { FastifyInstance } from 'fastify';
import { changeEmployerSettings, loadEmployer } from '@/services/employer.service';

export async function employerRoutes(app: FastifyInstance) {
  app.get('/settings', async (req) => loadEmployer(req.headers['x-employer'] as string).settings);
  app.patch<{ Body: { autoDisburse: boolean } }>('/settings', async (req) => {
    const employer = loadEmployer(req.headers['x-employer'] as string);
    return changeEmployerSettings(employer, req.body);
  });
}
