FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4311
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/deploy/qualification ./deploy/qualification
COPY --from=build --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 4311
HEALTHCHECK --interval=10s --timeout=4s CMD ["node", "bin/healthcheck.mjs"]
CMD ["node", "bin/production-entrypoint.mjs"]
