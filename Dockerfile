FROM node:26-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN npm i -g pnpm@11.22.0
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/agent/package.json packages/agent/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm --filter @microrun/server build
RUN pnpm --filter @microrun/server deploy --prod --legacy /out && cp -r packages/server/dist /out/dist

FROM node:26-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin \
 && apt-get purge -y curl gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
ENV NODE_ENV=production MICRORUN_DATA_DIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
CMD ["node", "dist/main.js"]
