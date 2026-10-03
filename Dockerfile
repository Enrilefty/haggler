# Quote Room on Cloud Run: one always-on instance (Slack Socket Mode + in-memory room state).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# The server binds 127.0.0.1 by default; a container must listen on every interface.
ENV HOST=0.0.0.0
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY data/cases ./data/cases
COPY data/photos ./data/photos
COPY data/reviews ./data/reviews
COPY data/shops.json ./data/shops.json
COPY data/catalog.json data/catalog.sample.json ./data/
COPY data/gio ./data/gio
# Secrets arrive as Cloud Run environment variables; no .env is baked into the image.
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
