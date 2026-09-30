FROM node:24.21.0-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY packages ./packages
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.21.0-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/else.sqlite
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/dist ./dist
COPY --from=build /app/PLAN/contracts ./PLAN/contracts
COPY --from=build /app/PLAN/prompts ./PLAN/prompts
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
VOLUME ["/data"]
CMD ["node", "dist/server/main.js"]
