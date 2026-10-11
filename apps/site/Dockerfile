# Build from the repository root: docker build -f apps/site/Dockerfile .
# The root context lets site media reuse tracked muxr assets through symlinks.
FROM node:22.23.2-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare yarn@1.22.22 --activate
COPY apps/site/package.json apps/site/tsconfig.json yarn.lock ./
RUN yarn install --frozen-lockfile --non-interactive
COPY apps/site/src ./src
RUN yarn build

FROM node:22.23.2-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app/apps/site
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node apps/site/docs ./docs
COPY --chown=node:node docs/store-preview/class /app/docs/store-preview/class
COPY --chown=node:node docs/play/store-assets /app/docs/play/store-assets
COPY --chown=node:node docs/assets/readme /app/docs/assets/readme
COPY --chown=node:node docs/art/rpg-cover.png /app/docs/art/rpg-cover.png
COPY --chown=node:node docs/demo/muxr-demo.mp4 /app/docs/demo/muxr-demo.mp4
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/site.js"]
