FROM node:18-alpine
WORKDIR /app
RUN npm install -g pnpm@11
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod
COPY dist/ ./dist/
ENTRYPOINT ["node", "dist/index.js"]
