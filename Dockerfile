# Playwright's image ships Chromium and its system libraries.
# Keep this tag in sync with the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=7860 \
    RUNS_DIR=/tmp/qa-agent-runs \
    MAX_CONCURRENT_RUNS=2

# Hugging Face Spaces runs containers as user 1000.
RUN chown -R 1000:1000 /app
USER 1000
EXPOSE 7860
CMD ["node", "dist/server/index.js"]
