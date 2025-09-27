FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Install deps separately for better layer caching
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src ./src

# Prepare audio dir
RUN mkdir -p /app/audio

# The bind-mounted config lands at /app/config.yml via compose
EXPOSE 3000
CMD ["node", "src/index.js"]
