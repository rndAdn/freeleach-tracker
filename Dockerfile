FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install

COPY *.js ./

CMD ["node", "prowlarr-watcher.js"]
