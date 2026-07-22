FROM node:22-alpine

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 5000

CMD ["node", "server.js"]
