FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
# Dev dependencies included: the server runs TypeScript through tsx
RUN npm ci

COPY . .

# Migrations are committed (src/db/migrations) and applied on startup

EXPOSE 3000

CMD ["node", "--import", "tsx", "src/index.ts"]
