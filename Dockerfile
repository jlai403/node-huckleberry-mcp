# syntax=docker/dockerfile:1

# Streamable-HTTP MCP server, built from source. The build stage type-checks with
# tsc (the repo's own `npm run build`), then dev dependencies are pruned so the
# runtime image carries only what `dist/` needs.
FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev

FROM node:24-slim

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Runs unprivileged; the official image ships a `node` user, and the app writes
# nothing outside HOME.
USER node

EXPOSE 8085

# /health is auth-exempt by design (see src/server/httpTransport.ts), so it is a
# safe probe and costs no credentials.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8085/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--transport", "http", "--port", "8085", "--host", "0.0.0.0"]
