FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund --progress=false
COPY . .
EXPOSE 3000
CMD ["npm","start"]
