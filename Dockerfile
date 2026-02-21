# =============================================================================
# mBot Studio — Multi-stage Docker Build
# =============================================================================
# Stage 1: Build the React frontend
# Stage 2: Production Node.js server serving frontend + API
# =============================================================================

# -- Stage 1: Build frontend --------------------------------------------------
FROM node:20-alpine AS frontend-build

WORKDIR /build

# Copy web package files and install
COPY web/package.json web/package-lock.json* ./web/
RUN cd web && npm ci

# Copy web source and build
COPY web/ ./web/
RUN cd web && npm run build


# -- Stage 2: Production server ------------------------------------------------
FROM node:20-alpine AS production

LABEL maintainer="mBot Studio"
LABEL description="AI-powered mBot2 programming platform for kids"

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Copy server package files and install production deps only
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev

# Copy server source
COPY server/src/ ./src/

# Copy firmware files (needed for mLink upload from Setup tab)
COPY firmware/ ./firmware/

# Copy default robot config
COPY server/robot-config.json ./robot-config.json

# Copy built frontend from stage 1
COPY --from=frontend-build /build/web/dist ./public/

# Create directory for persisted config
RUN mkdir -p /app/data

# Default environment
ENV NODE_ENV=production
ENV PORT=3001

# Expose the server port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

# Run as non-root
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN chown -R appuser:appgroup /app
USER appuser

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/index.js"]
