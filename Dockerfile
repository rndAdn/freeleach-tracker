FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY *.js ./
COPY public/ ./public/

CMD ["node", "prowlarr-watcher.js"]
