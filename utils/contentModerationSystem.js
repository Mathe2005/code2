

const fs = require('fs').promises;
const path = require('path');

// Georgian character mapping for QWERTY keyboard detection
const georgianQwertyMap = {
    'q': 'ქ', 'w': 'წ', 'e': 'ე', 'r': 'რ', 't': 'ტ', 'y': 'ყ', 'u': 'უ', 'i': 'ი', 'o': 'ო', 'p': 'პ',
    'a': 'ა', 's': 'ს', 'd': 'დ', 'f': 'ფ', 'g': 'გ', 'h': 'ჰ', 'j': 'ჯ', 'k': 'კ', 'l': 'ლ',
    'z': 'ზ', 'x': 'ხ', 'c': 'ც', 'v': 'ვ', 'b': 'ბ', 'n': 'ნ', 'm': 'მ'
};

// Severity levels
const severityLevels = {
    LOW: 'low',
    MEDIUM: 'medium',
    HIGH: 'high'
};

class ContentModerationSystem {
    constructor() {
        this.customWords = new Map(); // Guild-specific custom words
        this.settings = new Map(); // Guild-specific settings
        this.badWordsCache = new Map(); // Cache for bad words by guild
        this.globalBadWordsCache = null; // Cache for global bad words
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
        this.lastCacheUpdate = new Map();
    }

    // Load bad words from database
    async loadBadWords(guildId = null) {
        try {
            const { BadWord } = require('../config/database');
            
            // Check cache expiry
            const cacheKey = guildId || 'global';
            const lastUpdate = this.lastCacheUpdate.get(cacheKey) || 0;
            const now = Date.now();
            
            if (now - lastUpdate < this.cacheExpiry) {
                if (guildId) {
                    return this.badWordsCache.get(guildId) || [];
                } else {
                    return this.globalBadWordsCache || [];
                }
            }

            // Load from database
            const whereClause = guildId 
                ? { guildId: [guildId, null], isActive: true } // Guild-specific and global words
                : { guildId: null, isActive: true }; // Only global words

            const badWords = await BadWord.findAll({
                where: whereClause,
                attributes: ['word', 'language', 'severity', 'guildId']
            });

            const processedWords = badWords.map(bw => ({
                word: bw.word.toLowerCase(),
                language: bw.language,
                severity: bw.severity,
                isGuildSpecific: !!bw.guildId
            }));

            // Update cache
            if (guildId) {
                this.badWordsCache.set(guildId, processedWords);
            } else {
                this.globalBadWordsCache = processedWords;
            }
            this.lastCacheUpdate.set(cacheKey, now);

            return processedWords;
        } catch (error) {
            console.error('Error loading bad words from database:', error);
            return [];
        }
    }

    // Add bad word to database
    async addBadWord(word, language, severity, guildId = null, addedBy = null) {
        try {
            const { BadWord } = require('../config/database');
            
            const badWord = await BadWord.create({
                word: word.toLowerCase().trim(),
                language,
                severity,
                guildId,
                addedBy
            });

            // Clear cache for this guild
            const cacheKey = guildId || 'global';
            this.lastCacheUpdate.delete(cacheKey);
            if (guildId) {
                this.badWordsCache.delete(guildId);
            } else {
                this.globalBadWordsCache = null;
            }

            return badWord;
        } catch (error) {
            console.error('Error adding bad word to database:', error);
            throw error;
        }
    }

    // Remove bad word from database
    async removeBadWord(word, guildId = null) {
        try {
            const { BadWord } = require('../config/database');
            
            const result = await BadWord.destroy({
                where: {
                    word: word.toLowerCase().trim(),
                    guildId
                }
            });

            // Clear cache for this guild
            const cacheKey = guildId || 'global';
            this.lastCacheUpdate.delete(cacheKey);
            if (guildId) {
                this.badWordsCache.delete(guildId);
            } else {
                this.globalBadWordsCache = null;
            }

            return result > 0;
        } catch (error) {
            console.error('Error removing bad word from database:', error);
            throw error;
        }
    }

    // Get bad words for a guild
    async getBadWordsForGuild(guildId) {
        const words = await this.loadBadWords(guildId);
        return {
            english: words.filter(w => w.language === 'english'),
            georgian: words.filter(w => w.language === 'georgian'),
            harassment: words.filter(w => w.language === 'harassment'),
            custom: words.filter(w => w.language === 'custom')
        };
    }

    // Convert QWERTY typed Georgian to actual Georgian characters
    convertQwertyToGeorgian(text) {
        let converted = text.toLowerCase();
        for (const [qwerty, georgian] of Object.entries(georgianQwertyMap)) {
            converted = converted.replace(new RegExp(qwerty, 'g'), georgian);
        }
        return converted;
    }

    // Normalize text for better detection
    normalizeText(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s\u10A0-\u10FF]/g, ' ') // Keep only letters, numbers, spaces, and Georgian
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Check for leetspeak and common substitutions
    normalizeLeetspeak(text) {
        const leetMap = {
            '3': 'e', '1': 'i', '0': 'o', '4': 'a', '5': 's', '7': 't',
            '@': 'a', '$': 's', '!': 'i', '+': 't', 'ph': 'f'
        };
        
        let normalized = text.toLowerCase();
        for (const [leet, normal] of Object.entries(leetMap)) {
            // Escape special regex characters
            const escapedLeet = leet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            normalized = normalized.replace(new RegExp(escapedLeet, 'g'), normal);
        }
        return normalized;
    }

    // Detect Georgian words typed in QWERTY
    async detectGeorgianInQwerty(text, guildId) {
        const georgianConverted = this.convertQwertyToGeorgian(text);
        const detectedWords = [];
        
        const badWords = await this.loadBadWords(guildId);
        const georgianWords = badWords.filter(w => w.language === 'georgian');
        
        for (const wordData of georgianWords) {
            if (georgianConverted.includes(wordData.word) || text.toLowerCase().includes(wordData.word)) {
                detectedWords.push({
                    word: wordData.word,
                    type: 'georgian',
                    severity: wordData.severity
                });
            }
        }
        
        return detectedWords;
    }

    // Main detection function
    async analyzeContent(text, options = {}) {
        // Input validation
        if (!text || typeof text !== 'string') {
            return {
                isClean: true,
                detectedWords: [],
                detectedDetails: [],
                severity: severityLevels.LOW,
                confidence: 0,
                action: 'warn'
            };
        }

        const {
            sensitivity = 'medium',
            enableGeorgian = true,
            guildId = null,
            customWords = []
        } = options;

        console.log('Analyzing content:', text, 'with options:', options);

        const normalizedText = this.normalizeText(text);
        const leetNormalizedText = this.normalizeLeetspeak(normalizedText);
        const detectedWords = [];
        let maxSeverity = severityLevels.LOW;
        let confidence = 0;

        // Load bad words from database
        const badWords = await this.loadBadWords(guildId);
        console.log('Loaded bad words:', badWords.length);

        // Check all word types
        for (const wordData of badWords) {
            if (normalizedText.includes(wordData.word) || leetNormalizedText.includes(wordData.word)) {
                detectedWords.push({
                    word: wordData.word,
                    type: wordData.language,
                    severity: wordData.severity
                });
                if (this.compareSeverity(wordData.severity, maxSeverity) > 0) {
                    maxSeverity = wordData.severity;
                }
            }
        }

        // Check custom words if provided
        if (customWords && Array.isArray(customWords)) {
            console.log('Checking custom words:', customWords);
            for (const customWord of customWords) {
                const word = customWord.toLowerCase();
                if (normalizedText.includes(word) || leetNormalizedText.includes(word)) {
                    detectedWords.push({
                        word: word,
                        type: 'custom',
                        severity: 'medium'
                    });
                    if (this.compareSeverity('medium', maxSeverity) > 0) {
                        maxSeverity = 'medium';
                    }
                }
            }
        }

        // Check guild settings for custom words
        const guildSettings = this.getGuildSettings(guildId);
        if (guildSettings.customWords && Array.isArray(guildSettings.customWords)) {
            console.log('Checking guild custom words:', guildSettings.customWords);
            for (const customWord of guildSettings.customWords) {
                const word = customWord.toLowerCase();
                if (normalizedText.includes(word) || leetNormalizedText.includes(word)) {
                    detectedWords.push({
                        word: word,
                        type: 'custom',
                        severity: 'medium'
                    });
                    if (this.compareSeverity('medium', maxSeverity) > 0) {
                        maxSeverity = 'medium';
                    }
                }
            }
        }

        // Check Georgian words if enabled
        if (enableGeorgian) {
            const georgianDetected = await this.detectGeorgianInQwerty(text, guildId);
            detectedWords.push(...georgianDetected);
            
            for (const detection of georgianDetected) {
                if (this.compareSeverity(detection.severity, maxSeverity) > 0) {
                    maxSeverity = detection.severity;
                }
            }
        }

        console.log('Detected words:', detectedWords);

        // Calculate confidence based on number and severity of detections
        if (detectedWords.length > 0) {
            confidence = Math.min(0.5 + (detectedWords.length * 0.1) + 
                (maxSeverity === severityLevels.HIGH ? 0.3 : 
                 maxSeverity === severityLevels.MEDIUM ? 0.2 : 0.1), 1.0);
        }

        // Apply sensitivity filter
        const shouldFlag = this.shouldFlagContent(detectedWords, maxSeverity, sensitivity);

        const result = {
            isClean: !shouldFlag,
            detectedWords: detectedWords.map(d => d.word),
            detectedDetails: detectedWords,
            severity: maxSeverity,
            confidence: confidence,
            action: this.getRecommendedAction(maxSeverity, detectedWords.length)
        };

        console.log('Analysis result:', result);
        return result;
    }

    // Compare severity levels
    compareSeverity(severity1, severity2) {
        const levels = {
            [severityLevels.LOW]: 1,
            [severityLevels.MEDIUM]: 2,
            [severityLevels.HIGH]: 3
        };
        return levels[severity1] - levels[severity2];
    }

    // Determine if content should be flagged based on sensitivity
    shouldFlagContent(detectedWords, maxSeverity, sensitivity) {
        if (detectedWords.length === 0) return false;

        switch (sensitivity) {
            case 'low':
                return maxSeverity === severityLevels.HIGH;
            case 'medium':
                return maxSeverity === severityLevels.HIGH || maxSeverity === severityLevels.MEDIUM;
            case 'high':
                return detectedWords.length > 0;
            default:
                return maxSeverity === severityLevels.HIGH || maxSeverity === severityLevels.MEDIUM;
        }
    }

    // Get recommended action based on severity
    getRecommendedAction(severity, wordCount) {
        if (severity === severityLevels.HIGH) {
            return wordCount > 2 ? 'kick' : 'timeout';
        } else if (severity === severityLevels.MEDIUM) {
            return wordCount > 3 ? 'timeout' : 'delete';
        } else {
            return 'warn';
        }
    }

    // Save guild settings
    saveGuildSettings(guildId, settings) {
        this.settings.set(guildId, settings);
        this.customWords.set(guildId, settings.customWords || []);
    }

    // Get guild settings
    getGuildSettings(guildId) {
        return this.settings.get(guildId) || {
            enableModeration: true,
            enableGeorgian: true,
            actionType: 'warn',
            sensitivityLevel: 'medium',
            customWords: [],
            monitoredChannels: [],
            excludedRoles: []
        };
    }

    // Check if channel should be monitored
    shouldMonitorChannel(guildId, channelId) {
        const settings = this.getGuildSettings(guildId);
        return settings.monitoredChannels.length === 0 || 
               settings.monitoredChannels.includes(channelId);
    }

    // Check if user is excluded from moderation
    isUserExcluded(guildId, userRoles) {
        const settings = this.getGuildSettings(guildId);
        return settings.excludedRoles.some(roleId => userRoles.includes(roleId));
    }

    // Initialize default bad words (run once when setting up)
    async initializeDefaultBadWords() {
        try {
            const { BadWord } = require('../config/database');
            
            // Check if default words already exist
            const existingCount = await BadWord.count({
                where: { guildId: null }
            });

            if (existingCount > 0) {
                console.log('Default bad words already initialized');
                return;
            }

            console.log('Initializing default bad words...');

            // Default English bad words
            const englishWords = [
                { word: 'fuck', severity: 'medium' },
                { word: 'shit', severity: 'medium' },
                { word: 'bitch', severity: 'medium' },
                { word: 'asshole', severity: 'medium' },
                { word: 'damn', severity: 'low' },
                { word: 'hell', severity: 'low' },
                { word: 'bastard', severity: 'medium' },
                { word: 'crap', severity: 'low' },
                { word: 'stupid', severity: 'low' },
                { word: 'idiot', severity: 'low' },
                { word: 'moron', severity: 'low' },
                { word: 'retard', severity: 'high' },
                { word: 'gay', severity: 'medium' },
                { word: 'faggot', severity: 'high' },
                { word: 'nigger', severity: 'high' },
                { word: 'whore', severity: 'medium' },
                { word: 'slut', severity: 'medium' },
                { word: 'cunt', severity: 'high' },
                { word: 'pussy', severity: 'medium' },
                { word: 'dick', severity: 'medium' },
                { word: 'cock', severity: 'medium' }
            ];

            // Default Georgian bad words
            const georgianWords = [
                { word: 'დებილი', severity: 'medium' },
                { word: 'debili', severity: 'medium' },
                { word: 'dibili', severity: 'medium' },
                { word: 'შენი დედა', severity: 'high' },
                { word: 'sheni deda', severity: 'high' },
                { word: 'ცუდი', severity: 'low' },
                { word: 'cudi', severity: 'low' },
                { word: 'მოკვდი', severity: 'high' },
                { word: 'mokvdi', severity: 'high' },
                { word: 'იდიოტი', severity: 'low' },
                { word: 'idioti', severity: 'low' },
                { word: 'ბოზი', severity: 'medium' },
                { word: 'bozi', severity: 'medium' },
                { word: 'ძაღლი', severity: 'medium' },
                { word: 'zaghli', severity: 'medium' },
                { word: 'კურვა', severity: 'medium' },
                { word: 'kurva', severity: 'medium' },
                { word: 'ყლე', severity: 'medium' },
                { word: 'qle', severity: 'medium' },
                { word: 'yle', severity: 'medium' },
                { word: 'უბედური', severity: 'low' },
                { word: 'ubeduri', severity: 'low' },
                { word: 'სულელი', severity: 'low' },
                { word: 'suleli', severity: 'low' }
            ];

            // Default harassment phrases
            const harassmentWords = [
                { word: 'kill yourself', severity: 'high' },
                { word: 'kys', severity: 'high' },
                { word: 'go die', severity: 'high' },
                { word: 'nobody likes you', severity: 'high' },
                { word: 'you are worthless', severity: 'high' },
                { word: 'piece of shit', severity: 'high' },
                { word: 'waste of space', severity: 'high' },
                { word: 'you suck', severity: 'medium' },
                { word: 'loser', severity: 'medium' },
                { word: 'pathetic', severity: 'medium' },
                { word: 'disgusting', severity: 'medium' },
                { word: 'suicide', severity: 'high' },
                { word: 'murder', severity: 'high' },
                { word: 'rape', severity: 'high' },
                { word: 'nazi', severity: 'high' }
            ];

            // Insert all words
            const allWords = [
                ...englishWords.map(w => ({ ...w, language: 'english', guildId: null, isActive: true })),
                ...georgianWords.map(w => ({ ...w, language: 'georgian', guildId: null, isActive: true })),
                ...harassmentWords.map(w => ({ ...w, language: 'harassment', guildId: null, isActive: true }))
            ];

            await BadWord.bulkCreate(allWords);
            console.log(`Initialized ${allWords.length} default bad words`);

        } catch (error) {
            console.error('Error initializing default bad words:', error);
        }
    }
}

// Export singleton instance
module.exports = new ContentModerationSystem();
