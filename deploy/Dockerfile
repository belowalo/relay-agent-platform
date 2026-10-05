FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4311 PATH=/nodejs/bin:/usr/local/bin:/usr/bin:/bin
WORKDIR /app
COPY --from=build --chown=1000:1000 /app/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /app/dist ./dist
COPY --from=build --chown=1000:1000 /app/server ./server
COPY --from=build --chown=1000:1000 /app/bin ./bin
COPY --from=build --chown=1000:1000 /app/deploy/qualification ./deploy/qualification
COPY --from=build --chown=1000:1000 /app/package.json ./package.json
USER 1000:1000
ENTRYPOINT []
EXPOSE 4311
HEALTHCHECK --interval=10s --timeout=4s CMD ["node", "bin/healthcheck.mjs"]
CMD ["node", "bin/production-entrypoint.mjs"]
