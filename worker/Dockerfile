FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache iputils
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund --progress=false
COPY . .
CMD ["npm","start"]
