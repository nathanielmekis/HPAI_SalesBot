# ---- Build stage ----
FROM node:18-alpine AS build
WORKDIR /app

# Install dependencies and build the frontend
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:18-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# Install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy server and compiled frontend
COPY src/server.js ./src/server.js
COPY --from=build /app/dist ./dist

EXPOSE 3000
CMD ["node", "src/server.js"]
