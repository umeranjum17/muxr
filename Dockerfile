FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json yarn.lock tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps/relay ./apps/relay
# --ignore-scripts: the root postinstall (patch-package/native checks) targets the mobile app.
RUN yarn install --frozen-lockfile --non-interactive --ignore-scripts
RUN npx tsc --build apps/relay
# Production-only node_modules for the runtime image.
RUN rm -rf node_modules && yarn install --frozen-lockfile --non-interactive --ignore-scripts --production

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    MUXR_RELAY_HOST=0.0.0.0 \
    MUXR_RELAY_PORT=8792 \
    MUXR_RELAY_DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/relay ./apps/relay
VOLUME /data
EXPOSE 8792
RUN mkdir -p /data && chown node:node /data
USER node
CMD ["node", "apps/relay/dist/main.js"]
