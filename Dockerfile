FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY . .
ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "-e", "console.log('hello'); require('http').createServer((q,s)=>s.end('ok')).listen(3000,'0.0.0.0')"]
