FROM mcr.microsoft.com/playwright:v1.65.1-noble
WORKDIR /e2e
COPY package.json package-lock.json ./
RUN npm ci
COPY *.js ./
CMD ["npx", "playwright", "test"]
