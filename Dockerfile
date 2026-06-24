# Imagen del app Node (pipeline + dashboard de revisión). El Postgres+pgvector va en docker-compose.
FROM node:20-slim

WORKDIR /app

# Deps primero (cache de capas). Solo runtime: el proyecto usa módulos nativos de Node + `pg`.
COPY package*.json ./
RUN npm install --omit=dev

# Código + config (los datos personales reales van por volumen/.env; ver .dockerignore).
COPY . .

# Dashboard de revisión.
EXPOSE 5173
CMD ["node", "review/server.mjs"]
