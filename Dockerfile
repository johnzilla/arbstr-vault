FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --production=false

COPY . .

RUN npm run db:generate || true

EXPOSE 3000

CMD ["node", "--import", "tsx", "src/index.ts"]
