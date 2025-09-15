
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
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
        this.lastCacheUpdate = new Map();
        
        // Advanced detection patterns
        this.commonSubstitutions = this.buildSubstitutionMap();
        this.phoneticPatterns = this.buildPhoneticPatterns();
        this.bypassPatterns = this.buildBypassPatterns();
    }

    // Build comprehensive character substitution map
    buildSubstitutionMap() {
        return {
            // Numbers to letters
            '0': ['o', 'ო'], '1': ['i', 'l', 'ი'], '3': ['e', 'ე'], '4': ['a', 'ა'], '5': ['s', 'ს'],
            '6': ['g', 'გ'], '7': ['t', 'ტ'], '8': ['b', 'ბ'], '9': ['g', 'გ'],
            
            // Symbols to letters
            '@': ['a', 'ა'], '!': ['i', 'ი'], '#': ['h'], '$': ['s', 'ს'], '%': ['s', 'ს'],
            '^': ['a', 'ა'], '&': ['a', 'ა'], '*': ['a', 'ა'], '(': ['c', 'ც'], ')': ['c', 'ც'],
            '-': [''], '_': [''], '+': ['t', 'ტ'], '=': ['e', 'ე'], '[': ['c', 'ც'], ']': ['c', 'ც'],
            '{': ['c', 'ც'], '}': ['c', 'ც'], '|': ['i', 'l', 'ი'], '\\': [''], '/': [''],
            ':': [''], ';': [''], '"': [''], "'": [''], '<': ['c', 'ც'], '>': ['c', 'ც'],
            ',': [''], '.': [''], '?': [''], '~': [''], '`': [''],
            
            // Similar looking characters
            'а': ['a'], 'е': ['e'], 'о': ['o'], 'р': ['p'], 'с': ['c'], 'у': ['y'], 'х': ['x'],
            'А': ['A'], 'Е': ['E'], 'О': ['O'], 'Р': ['P'], 'С': ['C'], 'У': ['Y'], 'Х': ['X'],
            
            // Visual similarities
            'vv': ['w'], 'w': ['vv'], 'rn': ['m'], 'm': ['rn'], 'cl': ['d'], 'ii': ['u'],
            'oo': ['8'], 'll': ['u'], 'nn': ['u']
        };
    }

    // Build phonetic matching patterns
    buildPhoneticPatterns() {
        return {
            // Common phonetic equivalents
            'f': ['ph', 'gh'], 'k': ['c', 'ck', 'q'], 's': ['z', 'ss'], 'i': ['y', 'ee'],
            'u': ['oo', 'ou'], 'er': ['ur', 'or'], 'tion': ['shun', 'sion'], 'ph': ['f'],
            'ck': ['k'], 'qu': ['kw'], 'x': ['ks'], 'z': ['s']
        };
    }

    // Build bypass detection patterns
    buildBypassPatterns() {
        return [
            // Spaced out letters
            /(.)\s+(.)/g,
            // Repeated characters
            /(.)\1{2,}/g,
            // Mixed case
            /([A-Z])([a-z])/g,
            // Dots/periods between letters
            /(.)\.\s*(.)/g,
            // Dashes/hyphens
            /(.)[-_]\s*(.)/g,
            // Numbers mixed in
            /([a-zA-Z])\d+([a-zA-Z])/g
        ];
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
                return guildId ? (this.badWordsCache.get(guildId) || []) : [];
            }

            // Load only custom words from database for the specified guild
            const whereClause = guildId
                ? { guildId: guildId, language: 'custom', isActive: true }
                : { guildId: null, language: 'custom', isActive: true };

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
            this.badWordsCache.set(cacheKey, processedWords);
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
                language: 'custom',
                severity,
                guildId,
                addedBy
            });

            // Clear cache
            const cacheKey = guildId || 'global';
            this.lastCacheUpdate.delete(cacheKey);
            this.badWordsCache.delete(cacheKey);

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
                    guildId,
                    language: 'custom'
                }
            });

            // Clear cache
            const cacheKey = guildId || 'global';
            this.lastCacheUpdate.delete(cacheKey);
            this.badWordsCache.delete(cacheKey);

            return result > 0;
        } catch (error) {
            console.error('Error removing bad word from database:', error);
            throw error;
        }
    }

    // Get custom words for a guild
    async getBadWordsForGuild(guildId) {
        const words = await this.loadBadWords(guildId);
        return {
            custom: words.filter(w => w.language === 'custom')
        };
    }

    // Advanced Levenshtein distance calculation
    calculateLevenshteinDistance(str1, str2) {
        const matrix = [];
        const len1 = str1.length;
        const len2 = str2.length;

        if (len1 === 0) return len2;
        if (len2 === 0) return len1;

        // Initialize matrix
        for (let i = 0; i <= len2; i++) {
            matrix[i] = [i];
        }
        for (let j = 0; j <= len1; j++) {
            matrix[0][j] = j;
        }

        // Fill matrix
        for (let i = 1; i <= len2; i++) {
            for (let j = 1; j <= len1; j++) {
                if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        matrix[i][j - 1] + 1,     // insertion
                        matrix[i - 1][j] + 1      // deletion
                    );
                }
            }
        }

        return matrix[len2][len1];
    }

    // Calculate similarity using multiple algorithms
    calculateAdvancedSimilarity(word1, word2) {
        if (!word1 || !word2) return 0;
        if (word1 === word2) return 1;

        const len1 = word1.length;
        const len2 = word2.length;
        const maxLen = Math.max(len1, len2);
        
        // If length difference is too large, low similarity
        if (Math.abs(len1 - len2) > Math.min(len1, len2)) return 0;

        // Levenshtein similarity
        const levenshtein = 1 - (this.calculateLevenshteinDistance(word1, word2) / maxLen);
        
        // Jaro similarity
        const jaro = this.calculateJaroSimilarity(word1, word2);
        
        // Character overlap
        const overlap = this.calculateCharacterOverlap(word1, word2);
        
        // Substring containment
        const containment = (word1.includes(word2) || word2.includes(word1)) ? 0.8 : 0;
        
        // Weighted average
        return Math.max(
            levenshtein * 0.4 + jaro * 0.3 + overlap * 0.2 + containment * 0.1,
            containment
        );
    }

    // Jaro similarity calculation
    calculateJaroSimilarity(str1, str2) {
        if (str1 === str2) return 1;
        
        const len1 = str1.length;
        const len2 = str2.length;
        
        if (len1 === 0 || len2 === 0) return 0;
        
        const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
        const str1Matches = new Array(len1).fill(false);
        const str2Matches = new Array(len2).fill(false);
        
        let matches = 0;
        let transpositions = 0;
        
        // Find matches
        for (let i = 0; i < len1; i++) {
            const start = Math.max(0, i - matchWindow);
            const end = Math.min(i + matchWindow + 1, len2);
            
            for (let j = start; j < end; j++) {
                if (str2Matches[j] || str1[i] !== str2[j]) continue;
                str1Matches[i] = str2Matches[j] = true;
                matches++;
                break;
            }
        }
        
        if (matches === 0) return 0;
        
        // Count transpositions
        let k = 0;
        for (let i = 0; i < len1; i++) {
            if (!str1Matches[i]) continue;
            while (!str2Matches[k]) k++;
            if (str1[i] !== str2[k]) transpositions++;
            k++;
        }
        
        return (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
    }

    // Character overlap calculation
    calculateCharacterOverlap(str1, str2) {
        const chars1 = [...str1];
        const chars2 = [...str2];
        const used = new Set();
        let matches = 0;
        
        for (const char of chars1) {
            const index = chars2.findIndex((c, i) => c === char && !used.has(i));
            if (index !== -1) {
                used.add(index);
                matches++;
            }
        }
        
        return (matches * 2) / (chars1.length + chars2.length);
    }

    // Advanced text normalization with comprehensive cleaning
    deepNormalizeText(text) {
        let normalized = text.toLowerCase();

        // Remove excessive whitespace and normalize
        normalized = normalized.replace(/\s+/g, ' ').trim();

        // Apply substitution map for comprehensive character replacement
        for (const [original, replacements] of Object.entries(this.commonSubstitutions)) {
            if (Array.isArray(replacements)) {
                for (const replacement of replacements) {
                    const regex = new RegExp(this.escapeRegex(original), 'g');
                    normalized = normalized.replace(regex, replacement);
                }
            } else {
                const regex = new RegExp(this.escapeRegex(original), 'g');
                normalized = normalized.replace(regex, replacements);
            }
        }

        // Handle bypass patterns
        for (const pattern of this.bypassPatterns) {
            normalized = normalized.replace(pattern, '$1$2');
        }

        // Remove all non-letter characters except spaces
        const lettersOnly = normalized.replace(/[^a-zA-Z\u10A0-\u10FF\s]/g, '');
        
        // Create multiple variations
        const variations = [
            normalized,
            lettersOnly,
            lettersOnly.replace(/\s+/g, ''), // No spaces
            lettersOnly.replace(/(.)\1+/g, '$1'), // Remove duplicates
            this.generatePhoneticVariation(lettersOnly)
        ];

        return variations.filter(v => v && v.length > 0);
    }

    // Generate phonetic variations
    generatePhoneticVariation(text) {
        let phonetic = text;
        for (const [original, replacements] of Object.entries(this.phoneticPatterns)) {
            if (Array.isArray(replacements)) {
                for (const replacement of replacements) {
                    phonetic = phonetic.replace(new RegExp(replacement, 'g'), original);
                }
            }
        }
        return phonetic;
    }

    // Escape special regex characters
    escapeRegex(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Convert QWERTY typed Georgian to actual Georgian characters
    convertQwertyToGeorgian(text) {
        let converted = text.toLowerCase();

        // Direct character replacement
        for (const [qwerty, georgian] of Object.entries(georgianQwertyMap)) {
            converted = converted.replace(new RegExp(qwerty, 'gi'), georgian);
        }

        // Common Georgian word patterns with variations
        const georgianPatterns = {
            'debili': ['დებილი', 'დ3ბილი', 'd3bili', 'deb1li'],
            'dibili': ['დებილი', 'დიბილი'], 
            'sheni deda': ['შენი დედა', 'sh3ni d3da'],
            'mokvdi': ['მოკვდი', 'm0kvdi'],
            'bozi': ['ბოზი', 'b0zi'],
            'zaghli': ['ძაღლი', 'z4ghli'],
            'kurva': ['კურვა', 'kurv4'],
            'qle': ['ყლე', 'yl3'],
            'yle': ['ყლე', 'ql3'],
            'ubeduri': ['უბედური', 'ub3duri'],
            'suleli': ['სულელი', 'sul3li'],
            'cudi': ['ცუდი', 'cud1']
        };

        for (const [latin, georgianList] of Object.entries(georgianPatterns)) {
            for (const georgian of georgianList) {
                const regex = new RegExp(`\\b${this.escapeRegex(latin)}\\b`, 'gi');
                converted = converted.replace(regex, georgian);
            }
        }

        return converted;
    }

    // Advanced pattern matching with multiple algorithms
    detectWordWithAdvancedMatching(text, targetWord, confidence = 0.85) {
        const normalizedVariations = this.deepNormalizeText(text);
        const georgianConverted = this.convertQwertyToGeorgian(text);
        
        // Add Georgian conversion to variations
        normalizedVariations.push(georgianConverted);
        normalizedVariations.push(...this.deepNormalizeText(georgianConverted));

        console.log(`🔍 Advanced analysis for "${targetWord}"`);
        console.log(`📝 Text variations generated: ${normalizedVariations.length}`);

        let bestMatch = { found: false, confidence: 0, method: 'none', version: '' };

        for (const version of normalizedVariations) {
            if (!version || version.length < 2) continue;

            // 1. Direct substring match (highest confidence)
            if (version.includes(targetWord)) {
                console.log(`✅ Direct match: "${targetWord}" in "${version.substring(0, 50)}..."`);
                return { found: true, confidence: 1.0, method: 'direct', version };
            }

            // 2. Word boundary matches with similarity
            const words = version.split(/\s+/).filter(w => w.length > 1);
            for (const word of words) {
                const similarity = this.calculateAdvancedSimilarity(word, targetWord);
                if (similarity >= confidence) {
                    console.log(`✅ Similarity match: "${word}" vs "${targetWord}" = ${(similarity * 100).toFixed(1)}%`);
                    if (similarity > bestMatch.confidence) {
                        bestMatch = { found: true, confidence: similarity, method: 'similarity', version };
                    }
                }
            }

            // 3. Fuzzy substring matching
            const fuzzyMatch = this.findFuzzySubstring(version, targetWord, confidence);
            if (fuzzyMatch.found && fuzzyMatch.confidence > bestMatch.confidence) {
                console.log(`✅ Fuzzy match: "${targetWord}" in "${version.substring(0, 50)}..." with ${(fuzzyMatch.confidence * 100).toFixed(1)}% confidence`);
                bestMatch = { found: true, confidence: fuzzyMatch.confidence, method: 'fuzzy', version };
            }

            // 4. Character sequence detection (for heavily obfuscated words)
            if (this.detectCharacterSequence(version, targetWord, 0.75)) {
                const sequenceConfidence = 0.85;
                if (sequenceConfidence > bestMatch.confidence) {
                    console.log(`✅ Sequence match: "${targetWord}" detected in "${version.substring(0, 50)}..."`);
                    bestMatch = { found: true, confidence: sequenceConfidence, method: 'sequence', version };
                }
            }

            // 5. Reversed word detection
            const reversedTarget = targetWord.split('').reverse().join('');
            if (version.includes(reversedTarget)) {
                const reverseConfidence = 0.9;
                if (reverseConfidence > bestMatch.confidence) {
                    console.log(`✅ Reverse match: "${reversedTarget}" (reversed "${targetWord}") in "${version.substring(0, 50)}..."`);
                    bestMatch = { found: true, confidence: reverseConfidence, method: 'reverse', version };
                }
            }
        }

        return bestMatch;
    }

    // Fuzzy substring matching
    findFuzzySubstring(text, target, threshold) {
        const targetLen = target.length;
        let bestMatch = { found: false, confidence: 0 };

        for (let i = 0; i <= text.length - targetLen; i++) {
            for (let len = targetLen - 2; len <= targetLen + 2; len++) {
                if (i + len > text.length) continue;
                
                const substring = text.substring(i, i + len);
                const similarity = this.calculateAdvancedSimilarity(substring, target);
                
                if (similarity >= threshold && similarity > bestMatch.confidence) {
                    bestMatch = { found: true, confidence: similarity };
                }
            }
        }

        return bestMatch;
    }

    // Enhanced character sequence detection
    detectCharacterSequence(text, targetWord, threshold = 0.8) {
        const cleanText = text.replace(/[^a-zA-Z\u10A0-\u10FF]/g, '').toLowerCase();
        const targetChars = targetWord.toLowerCase().split('');

        if (targetChars.length === 0) return false;

        let matchedChars = 0;
        let textIndex = 0;
        let maxGap = Math.floor(targetChars.length / 2); // Allow some gaps

        for (const targetChar of targetChars) {
            let found = false;
            let searchEnd = Math.min(textIndex + maxGap + 5, cleanText.length);
            
            for (let i = textIndex; i < searchEnd; i++) {
                if (cleanText[i] === targetChar) {
                    matchedChars++;
                    textIndex = i + 1;
                    found = true;
                    break;
                }
            }
            
            if (!found) {
                // Try alternative characters for the target
                const alternatives = this.commonSubstitutions[targetChar] || [];
                for (const alt of alternatives) {
                    for (let i = textIndex; i < searchEnd; i++) {
                        if (cleanText[i] === alt) {
                            matchedChars++;
                            textIndex = i + 1;
                            found = true;
                            break;
                        }
                    }
                    if (found) break;
                }
            }
        }

        const matchRatio = matchedChars / targetChars.length;
        return matchRatio >= threshold;
    }

    // Main analysis function with comprehensive detection
    async analyzeContent(text, options = {}) {
        if (!text || typeof text !== 'string') {
            return {
                isClean: true,
                detectedWords: [],
                detectedDetails: [],
                severity: severityLevels.LOW,
                confidence: 0,
                action: 'warn',
                analysisMethod: 'input_validation_fail'
            };
        }

        const { sensitivity = 'medium', guildId = null } = options;

        console.log(`🔬 Deep content analysis starting for: "${text}"`);
        console.log(`⚙️ Sensitivity: ${sensitivity}, Guild: ${guildId}`);

        const detectedWords = [];
        let maxSeverity = severityLevels.LOW;
        let totalConfidence = 0;

        // Load custom words
        const badWords = await this.loadBadWords(guildId);
        console.log(`📚 Loaded ${badWords.length} custom words for analysis`);

        // Set confidence threshold based on sensitivity
        const confidenceThreshold = {
            'low': 0.98,     // Very strict
            'medium': 0.85,  // Balanced
            'high': 0.70     // More sensitive
        }[sensitivity] || 0.85;

        console.log(`🎯 Confidence threshold: ${confidenceThreshold} (${sensitivity} sensitivity)`);

        // Analyze each custom word with advanced matching
        for (const wordData of badWords) {
            const targetWord = wordData.word.toLowerCase();
            console.log(`🔍 Analyzing target: "${targetWord}" (${wordData.severity})`);

            const detection = this.detectWordWithAdvancedMatching(text, targetWord, confidenceThreshold);

            if (detection.found && detection.confidence >= confidenceThreshold) {
                console.log(`🚨 DETECTION: "${targetWord}" with ${(detection.confidence * 100).toFixed(1)}% confidence (${detection.method})`);

                detectedWords.push({
                    word: wordData.word,
                    type: 'custom',
                    severity: wordData.severity,
                    confidence: detection.confidence,
                    method: detection.method,
                    detectedVersion: detection.version
                });

                if (this.compareSeverity(wordData.severity, maxSeverity) > 0) {
                    maxSeverity = wordData.severity;
                }

                totalConfidence = Math.min(1.0, totalConfidence + detection.confidence * 0.3);
            } else {
                console.log(`⚪ No detection for "${targetWord}" (best confidence: ${(detection.confidence * 100).toFixed(1)}%)`);
            }
        }

        // Apply sensitivity-based flagging logic
        const shouldFlag = this.shouldFlagContent(detectedWords, maxSeverity, sensitivity);

        const result = {
            isClean: !shouldFlag,
            detectedWords: detectedWords.map(d => d.word),
            detectedDetails: detectedWords,
            severity: maxSeverity,
            confidence: totalConfidence,
            action: this.getRecommendedAction(maxSeverity, detectedWords.length),
            analysisMethod: 'advanced_pattern_matching'
        };

        console.log(`📊 Analysis complete: ${detectedWords.length} detections, flagged: ${shouldFlag}`);
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

    // Enhanced flagging logic
    shouldFlagContent(detectedWords, maxSeverity, sensitivity) {
        if (detectedWords.length === 0) return false;

        const highConfidenceDetections = detectedWords.filter(d => d.confidence >= 0.95);
        const mediumConfidenceDetections = detectedWords.filter(d => d.confidence >= 0.85 && d.confidence < 0.95);
        const lowConfidenceDetections = detectedWords.filter(d => d.confidence < 0.85);

        switch (sensitivity) {
            case 'low':
                return maxSeverity === severityLevels.HIGH && highConfidenceDetections.length > 0;
            case 'medium':
                return (maxSeverity === severityLevels.HIGH) ||
                       (maxSeverity === severityLevels.MEDIUM && mediumConfidenceDetections.length > 0);
            case 'high':
                return detectedWords.length > 0;
            default:
                return maxSeverity === severityLevels.HIGH || maxSeverity === severityLevels.MEDIUM;
        }
    }

    // Get recommended action
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

    // Check if user is excluded
    isUserExcluded(guildId, userRoles) {
        const settings = this.getGuildSettings(guildId);
        return settings.excludedRoles.some(roleId => userRoles.includes(roleId));
    }
}

// Export singleton instance
module.exports = new ContentModerationSystem();
