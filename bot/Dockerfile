FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-alpine

WORKDIR /app

# Install Claude CLI and GitHub CLI
RUN apk add --no-cache github-cli && \
    npm install -g @anthropic-ai/claude-code

COPY package*.json ./
RUN npm ci --only=production

COPY --from=builder /app/dist ./dist
COPY src/skills ./dist/skills

# Include source files so the bot can read its own code
COPY src ./source/bot/src
COPY package.json ./source/bot/package.json
COPY tsconfig.json ./source/bot/tsconfig.json

RUN mkdir -p /app/data

CMD ["node", "dist/index.js"]
