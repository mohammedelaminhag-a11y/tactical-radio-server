FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY --chown=node:node . .
ENV NODE_ENV=production
EXPOSE 3000
USER node
CMD ["node", "server.js"]
