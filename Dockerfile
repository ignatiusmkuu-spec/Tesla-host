FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY server.js ./server.js
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
COPY app.json ./app.json
COPY README.md ./README.md

RUN chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server.js"]
