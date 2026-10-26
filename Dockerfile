# Serves the built web app together with the CORS proxy.
#   docker build -t bangdb-manager .
#   docker run -p 8080:8080 -e BANGDB_URL=http://192.168.0.10:18080 bangdb-manager
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY proxy ./proxy
ENV PORT=8080 BANGDB_URL=http://127.0.0.1:18080
EXPOSE 8080
CMD ["node", "proxy/server.mjs"]
