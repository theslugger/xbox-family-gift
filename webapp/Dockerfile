FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --silent

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node","src/server.js"]
