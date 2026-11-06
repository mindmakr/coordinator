import type { FastifyInstance } from 'fastify';
import { changeEmployerSettings, loadEmployer } from '@/services/employer.service';
import { disburse } from '@/services/ewa.service';

// A local step between the handler and the service: the map follows it one call deep.
function payOut(employerId: string) {
  return disburse(employerId, 1000);
}

export async function employerRoutes(app: FastifyInstance) {
  app.get('/settings', async (req) => loadEmployer(req.headers['x-employer'] as string).settings);
  app.patch<{ Body: { autoDisburse: boolean } }>('/settings', async (req) => {
    const employer = loadEmployer(req.headers['x-employer'] as string);
    return changeEmployerSettings(employer, req.body);
  });
  app.post('/disburse', async (req) => payOut(req.headers['x-employer'] as string));
}
