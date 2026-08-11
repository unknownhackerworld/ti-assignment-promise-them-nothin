FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code
COPY src/ ./src/

# Expose application port
EXPOSE 3000

# Start the application
CMD ["node", "src/server.js"]
