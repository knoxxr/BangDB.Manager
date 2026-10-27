# Serves the built web app together with the CORS proxy and the database
# gateway (PostgreSQL, MySQL, SQL Server, SQLite, MongoDB, Redis).
#   docker build -t bangdb-manager .
#   docker run -p 8080:8080 -e BANGDB_URL=http://192.168.0.10:18080 -e GATEWAY_TOKEN=secret -v $PWD/data:/data bangdb-manager
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# build the committed version as is (no prebuild patch bump)
RUN NO_VERSION_BUMP=1 npm run build

FROM node:22-alpine
WORKDIR /app
COPY proxy/package*.json ./proxy/
RUN npm ci --omit=dev --prefix proxy
COPY --from=build /app/dist ./dist
COPY proxy/server.mjs ./proxy/
COPY proxy/gateway ./proxy/gateway
# SQLITE_ROOT: the only folder whose SQLite files the gateway opens
ENV PORT=8080 BANGDB_URL=http://127.0.0.1:18080 SQLITE_ROOT=/data
VOLUME /data
EXPOSE 8080
CMD ["node", "proxy/server.mjs"]
