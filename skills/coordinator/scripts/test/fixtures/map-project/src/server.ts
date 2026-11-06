import Fastify from 'fastify';
import { employerRoutes } from './routes/employer.js';

const app = Fastify();
app.register(employerRoutes, { prefix: '/v1/employer' });
app.listen({ port: Number(process.env.PORT ?? 4000) });
