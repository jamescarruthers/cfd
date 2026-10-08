FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends openfoam=1912.200626-3+b1 libopenfoam=1912.200626-3+b1 openmpi-bin ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --cache /tmp/npm-cache && rm -rf /tmp/npm-cache
COPY . .
ENV CFD_OPENFOAM_DIR=/ CFD_RUNS_DIR=/data/jobs
EXPOSE 5173
CMD ["npm", "run", "dev"]
