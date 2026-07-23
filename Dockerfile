FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package.json and install dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Copy all source code
COPY . .

# Expose port
EXPOSE 3131

# Start the server
CMD ["node", "backend/server.js"]
