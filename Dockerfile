FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Copy all source code
COPY . .

# Create volume for persistent SQLite database and uploads
VOLUME ["/app/backend/data"]

# Expose port
EXPOSE 3131

# Start the server
CMD ["node", "backend/server.js"]
