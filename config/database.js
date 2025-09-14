
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
const BadWord = require('../models/BadWord')(sequelize);

// Database connection and sync
async function initializeDatabase() {
    try {
        await sequelize.authenticate();
        console.log('Database connection established successfully.');

        // Sync all models
        await sequelize.sync({ alter: true });
        console.log('Database synchronized.');

        // Initialize default bad words
        const moderationSystem = require('../utils/contentModerationSystem');
        await moderationSystem.initializeDefaultBadWords();
    } catch (error) {
        console.error('Unable to connect to the database:', error);
        process.exit(1);
    }
}

module.exports = { 
    sequelize, 
    initializeDatabase, 
    CustomNickname: require('../models/CustomNickname')(sequelize),
    ContentModerationConfig: require('../models/ContentModerationConfig')(sequelize),
    BadWord: require('../models/BadWord')(sequelize)
};
