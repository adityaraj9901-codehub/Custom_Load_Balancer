# Production image for the load balancer — zero runtime dependencies.
FROM node:22-alpine

WORKDIR /app

# Only copy what the runtime needs (no dev deps, no build step).
COPY package.json ./
COPY config.json ./
COPY src ./src

ENV NODE_ENV=production
EXPOSE 8080

# Run as the unprivileged built-in node user.
USER node

# Liveness: the admin endpoint reports degraded (503) when no upstream is usable.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/__lb/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
