# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Install btrfs-progs for the sync scripts
RUN apk add --no-cache btrfs-progs sudo coreutils

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy TypeScript config and source
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine

WORKDIR /app

# Install btrfs-progs for the sync scripts
RUN apk add --no-cache btrfs-progs sudo coreutils

# Copy built files
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./

EXPOSE 3001

CMD ["node", "dist/server.js"]
