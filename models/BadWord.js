
const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
    const BadWord = sequelize.define('BadWord', {
        id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true
        },
        word: {
            type: DataTypes.STRING(255),
            allowNull: false
        },
        language: {
            type: DataTypes.ENUM('english', 'georgian', 'harassment', 'custom'),
            defaultValue: 'custom',
            allowNull: false
        },
        severity: {
            type: DataTypes.ENUM('low', 'medium', 'high'),
            defaultValue: 'medium',
            allowNull: false
        },
        guildId: {
            type: DataTypes.STRING(255),
            allowNull: true // null means global word, specific guildId means guild-specific
        },
        isActive: {
            type: DataTypes.BOOLEAN,
            defaultValue: true,
            allowNull: false
        },
        addedBy: {
            type: DataTypes.STRING(255),
            allowNull: true
        }
    }, {
        tableName: 'bad_words',
        timestamps: true,
        indexes: [
            {
                fields: ['word', 'guildId']
            },
            {
                fields: ['language']
            },
            {
                fields: ['guildId']
            }
        ]
    });

    return BadWord;
};
