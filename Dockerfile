FROM ghcr.io/puppeteer/puppeteer:24.43.1

USER root
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --chown=pptruser:pptruser public ./public
COPY --chown=pptruser:pptruser src ./src
COPY --chown=pptruser:pptruser README.md ./README.md

RUN mkdir -p /app/.browser-profile /app/.browser-sessions \
    && chown -R pptruser:pptruser /app

USER pptruser
EXPOSE 3000

CMD ["node", "src/server.js"]
