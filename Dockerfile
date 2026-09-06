FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
LABEL org.opencontainers.image.source="https://github.com/markup-carve/carve-mcp"
LABEL org.opencontainers.image.description="MCP server for authoring and converting Carve documents"
WORKDIR /app
ENV NODE_ENV=production
ENV CARVE_MCP_ALLOWED_HOSTS=localhost,127.0.0.1
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js", "--http", "--host=0.0.0.0", "--port=3000"]
