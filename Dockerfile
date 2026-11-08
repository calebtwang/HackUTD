# Exact supported Node release; install the browser matching package-lock.json.
FROM node:26.13.0-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
# tsx and Vite are currently devDependencies and are needed by the runtime/build.
RUN npm ci --include=dev
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:26.13.0-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DOTENV_CONFIG_PATH=/run/secrets/demo.env \
    NODE_OPTIONS=--max-old-space-size=768
COPY --from=build /app/node_modules ./node_modules
RUN ./node_modules/.bin/playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/* /root/.npm
COPY package.json package-lock.json ./
COPY --from=build /app/dist ./dist
COPY server ./server
COPY workers ./workers
COPY shared ./shared
COPY deploy/healthcheck.mjs deploy/supervise.mjs ./deploy/
RUN mkdir -p /app/.local && chown node:node /app/.local
USER node
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=8s --start-period=90s --retries=3 \
    CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "deploy/supervise.mjs"]
