FROM node:20-alpine
WORKDIR /app

# Railway does not need the local .env.example file inside the image.
# Runtime secrets/config are provided through Railway Variables.
COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./
COPY README_PASHTO.txt ./

EXPOSE 8080
CMD ["npm", "start"]
