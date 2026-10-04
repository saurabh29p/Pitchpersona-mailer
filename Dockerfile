FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 8080
CMD ["node", "--experimental-sqlite", "--no-warnings", "src/index.mjs"]
