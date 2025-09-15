const { Sequelize } = require('sequelize');
require('dotenv').config();

// Database setup
const sequelize = new Sequelize(
    process.env.DB_NAME || 'discordbot',
    process.env.DB_USER || '',
    process.env.DB_PASSWORD || '',
    {
        host: process.env.DB_HOST || '...',
        dialect: 'mysql',
        logging: false,
        pool: {
            max: 5,
            min: 0,
            acquire: 30000,
            idle: 10000
        }
    }
);

// Initialize models
const GuildConfig = require('../models/GuildConfig')(sequelize);
const AuditLog = require('../models/AuditLog')(sequelize);
const CustomNickname = require('../models/CustomNickname')(sequelize);
const ContentModerationConfig = require('../models/ContentModerationConfig')(sequelize);

// Database connection and sync
async function initializeDatabase() {
    try {
        await sequelize.authenticate();
        console.log('Database connection established successfully.');

        // Sync all models
        await sequelize.sync({ alter: true });
        console.log('Database synchronized.');
    } catch (error) {
        console.error('Unable to connect to the database:', error);
    }
}

module.exports = { 
    sequelize, 
    initializeDatabase, 
    CustomNickname,
    ContentModerationConfig
};
