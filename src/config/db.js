const mongoose = require('mongoose');
const logger = require('../utils/logger');

const connectDB = async () => {
  const projectName = process.env.PROJECT_NAME;
  const baseUri = process.env.MONGO_URI;

  if (!projectName) {
    throw new Error('PROJECT_NAME is not set in .env — this determines the database name.');
  }
  if (!baseUri) {
    throw new Error('MONGO_URI is not set in .env');
  }

  // Guard against someone pasting a URI that already has a db name / trailing slash.
  const cleanBase = baseUri.replace(/\/+$/, '');
  const fullUri = `${cleanBase}/${projectName}?retryWrites=true&w=majority`;

  mongoose.set('strictQuery', true);

  const conn = await mongoose.connect(fullUri, {
    maxPoolSize: 20,
    serverSelectionTimeoutMS: 10000,
  });

  logger.info(`MongoDB connected → host: ${conn.connection.host} | database: "${conn.connection.name}"`);

  mongoose.connection.on('error', (err) => {
    logger.error(`MongoDB connection error: ${err.message}`);
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  return conn;
};

module.exports = connectDB;
