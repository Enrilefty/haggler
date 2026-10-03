# Quote Room on Cloud Run: one always-on instance (Slack Socket Mode + in-memory room state).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY data/cases ./data/cases
COPY data/photos ./data/photos
COPY data/reviews ./data/reviews
COPY data/shops.json ./data/shops.json
# Secrets arrive as Cloud Run environment variables; no .env is baked into the image.
CMD ["node", "--experimental-strip-types", "--no-warnings", "src/server.ts"]
