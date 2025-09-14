
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const ContentModerationConfig = sequelize.define('ContentModerationConfig', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        guildId: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        enableModeration: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
            allowNull: false
        },
        enableGeorgian: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
            allowNull: false
        },
        actionType: {
            type: DataTypes.ENUM('warn', 'delete', 'timeout', 'kick'),
            defaultValue: 'warn',
            allowNull: false
        },
        sensitivityLevel: {
            type: DataTypes.ENUM('low', 'medium', 'high'),
            defaultValue: 'medium',
            allowNull: false
        },
        customWords: {
            type: DataTypes.JSON,
            defaultValue: [],
            allowNull: false
        },
        monitoredChannels: {
            type: DataTypes.JSON,
            defaultValue: [],
            allowNull: false
        },
        excludedRoles: {
            type: DataTypes.JSON,
            defaultValue: [],
            allowNull: false
        },
        logChannel: {
            type: DataTypes.STRING(255),
            allowNull: true
        }
    }, {
        tableName: 'content_moderation_configs',
        timestamps: true,
        indexes: [
            {
                unique: true,
                fields: ['guildId']
            }
        ]
    });

    return ContentModerationConfig;
};
