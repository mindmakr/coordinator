# Build from the repository root, so the skill's shared code comes along:
#   docker build -f service/Dockerfile -t coordinator-service .
# The service imports the skill's lib at ../skills/coordinator/scripts/lib.
FROM node:22-alpine AS deps
WORKDIR /app/service
COPY service/package.json service/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY skills/coordinator/scripts/lib ./skills/coordinator/scripts/lib
COPY --from=deps /app/service/node_modules ./service/node_modules
COPY service/package.json service/LICENSE ./service/
COPY service/src ./service/src
COPY service/sql ./service/sql
WORKDIR /app/service
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1
CMD ["node", "src/main.mjs"]
