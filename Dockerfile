FROM node:22-bookworm-slim AS build

WORKDIR /app

# Compilers only in case better-sqlite3 has no prebuilt binary for this platform.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# src/lib/server/db/index.ts throws without DATABASE_URL, even while SvelteKit analyses the build.
ENV DATABASE_URL=/tmp/build.db
RUN npm run build


FROM node:22-bookworm-slim

WORKDIR /app

# LibreOffice turns Word files into PDFs; the fonts keep the layout close to Word's.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		libreoffice-writer \
		fonts-liberation \
		fonts-dejavu-core \
		fonts-crosextra-carlito \
		fonts-crosextra-caladea \
	&& rm -rf /var/lib/apt/lists/*

# Same base image as the build stage, so the compiled better-sqlite3 matches.
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Chromium renders the Markdown PDFs (src/lib/server/files/render/pdf.ts).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx playwright install --with-deps chromium \
	&& rm -rf /var/lib/apt/lists/* \
	&& chmod -R a+rX /ms-playwright

COPY --from=build /app/build ./build
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY docker-entrypoint.sh ./
RUN sed -i 's/\r$//' docker-entrypoint.sh

# The volume mounted at /data inherits this ownership the first time it is created.
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
	HOST=0.0.0.0 \
	PORT=3000 \
	DATABASE_URL=/data/local.db \
	DATA_DIR=/data/files \
	CHROMIUM_NO_SANDBOX=1

USER node
EXPOSE 3000
VOLUME /data

ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
