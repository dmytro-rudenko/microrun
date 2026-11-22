FROM node:26-alpine
ARG APP_VERSION
WORKDIR /app
RUN npm i postgres@4.1.1
COPY app.mjs migrate.mjs ./
COPY migrations/${APP_VERSION} ./migrations
ENV APP_VERSION=$APP_VERSION
HEALTHCHECK --interval=1s --timeout=2s --retries=30 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node","app.mjs"]
