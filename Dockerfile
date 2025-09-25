# ---- Build stage ----
FROM node:18-alpine AS build
WORKDIR /app

# 1) Install deps (with devDeps for Vite build), using layer caching
COPY package*.json ./
RUN npm ci --include=dev

# 2) Copy source and build
#    If you have a `public/` folder, it will be picked up by Vite.
COPY . .
# Optionally pass build-time env (e.g., VITE_*):  docker build --build-arg VITE_API_BASE=/api .
ARG VITE_API_BASE
ENV VITE_API_BASE=${VITE_API_BASE}
RUN npm run build

# ---- Runtime stage ----
FROM node:18-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# 3) Install only production deps
COPY package*.json ./
RUN npm ci --omit=dev

# 4) Copy server code and compiled frontend
#    Copy the entire server dir in case server.js imports other modules.
COPY src ./src
COPY --from=build /app/dist ./dist

# (Optional) If you serve any static files from /public at runtime:
# COPY --from=build /app/public ./public

# 5) Security: run as the node user
USER node

EXPOSE 3000
CMD ["node", "src/server.js"]
