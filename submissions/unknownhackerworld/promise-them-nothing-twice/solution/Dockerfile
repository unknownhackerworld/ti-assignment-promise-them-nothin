FROM node:18-alpine

# Create non-root user to avoid running as root inside the container
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy application code
COPY src/ ./src/

# Transfer ownership so the non-root user can read files
RUN chown -R appuser:appgroup /app

# Drop to non-root user before starting the process
USER appuser

# Expose application port
EXPOSE 3000

# Start the application
CMD ["node", "src/server.js"]
