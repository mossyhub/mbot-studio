FROM node:22-alpine AS web-build
WORKDIR /build
COPY package.json package-lock.json ./
COPY web/package.json web/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY web/ web/
RUN npm run build --workspace=web

FROM nginx:alpine
ARG SOURCE_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/mossyhub/mbot-studio" \
      org.opencontainers.image.revision=$SOURCE_REVISION \
      org.opencontainers.image.description="Guided test frontend; existing Studio API and robot owner are shared"
COPY deploy/guided/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /build/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
 CMD wget -qO- http://127.0.0.1:8080/test-health || exit 1
