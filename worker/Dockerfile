FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache iputils
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
CMD ["npm","start"]
