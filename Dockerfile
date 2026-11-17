FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
# Only needed for multi-company mode (DATABASE_URL); single-agency mode has no dependencies to run.
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production
ENV DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "server.js"]
