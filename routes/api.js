const express = require('express');
const router = express.Router();
const { ensureRole, ensureDjOrAdmin, ensureAuthenticated } = require('../middleware/auth');
const { getOrCreateGuildConfig, updateMemberNickname } = require('../utils/guildUtils');
const { logAction, trackDashboardAction } = require('../utils/auditLogger');
const { getMusicQueue, broadcastMusicUpdate, manager, playNextSong } = require('../services/musicService');
const { Sequelize, Op } = require('sequelize');
const client = require('../config/discord');
const { getRealIP, createAdvancedRateLimit } = require('../middleware/security');

// Add this at the top after the imports
let wss;

// Set WebSocket server reference
function setWebSocketServer(websocketServer) {
    wss = websocketServer;
}

// Broadcast function for real-time updates
function broadcastToGuild(guildId, data) {
    if (!wss) return;

    wss.clients.forEach(client => {
        if (client.readyState === 1 && client.guildId === guildId) {
            client.send(JSON.stringify(data));
        }
    });
}

// Health check endpoint
router.get('/health', (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// API security monitoring middleware
router.use((req, res, next) => {
    const ip = getRealIP(req);
    const userAgent = req.headers['user-agent'] || 'Unknown';
    const endpoint = req.path;

    // Log API access for monitoring
    if (req.user) {
        console.log(`📊 API Access: ${req.user.username} from ${ip} -> ${req.method} ${endpoint}`);
    } else {
        console.log(`📊 Unauthenticated API Access: ${ip} -> ${req.method} ${endpoint}`);
    }

    // Set response time header for monitoring
    const startTime = Date.now();
    res.on('finish', () => {
        const responseTime = Date.now() - startTime;

        // Only set header if response hasn't been sent yet
        if (!res.headersSent) {
            try {
                res.setHeader('X-Response-Time', `${responseTime}ms`);
            } catch (error) {
                // Ignore header setting errors
            }
        }

        // Log slow responses
        if (responseTime > 5000) {
            console.log(`⚠️ Slow API Response: ${endpoint} took ${responseTime}ms for ${ip}`);
        }
    });

    next();
});

// Enhanced rate limiting for specific API endpoints
router.use('/dashboard/:guildId/music/play', createAdvancedRateLimit({
    windowMs: 2 * 60 * 1000, // 2 minutes
    max: 10, // Max 10 songs per 2 minutes
    message: {
        error: 'Music rate limit exceeded',
        message: 'Too many songs added, please wait before adding more'
    }
}));

router.use('/dashboard/:guildId/member/:memberId/kick', createAdvancedRateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 5, // Max 5 kicks per 10 minutes
    message: {
        error: 'Moderation rate limit exceeded',
        message: 'Too many moderation actions, please wait'
    }
}));

router.use('/dashboard/:guildId/member/:memberId/ban', createAdvancedRateLimit({
    windowMs: 10 * 60 * 1000, // 10 minutes
    max: 3, // Max 3 bans per 10 minutes
    message: {
        error: 'Ban rate limit exceeded',
        message: 'Too many ban actions, please wait'
    }
}));

// Force music state update for page loads/refreshes
router.get('/dashboard/:guildId/music/status', ensureAuthenticated, async (req, res) => {
    const guildId = req.params.guildId;

    try {
        const { getMusicQueue, getPlayerForGuild, broadcastMusicUpdate } = require('../services/musicService');
        const musicQueue = getMusicQueue(guildId);
        const player = getPlayerForGuild(guildId);

        // Force update the current song if player has one but queue doesn't
        if (player && player.queue && player.queue.current && !musicQueue.currentSong) {
            const track = player.queue.current;
            musicQueue.currentSong = {
                title: track.info.title,
                url: track.info.uri,
                duration: track.info.length || track.info.duration || 0,
                addedBy: track.info.requester || 'Unknown',
                thumbnail: track.info.artworkUrl || track.info.thumbnail || null
            };
            musicQueue.isPlaying = !player.paused;
        }

        // Broadcast current state to ensure UI is in sync
        broadcastMusicUpdate(guildId, musicQueue, wss, 'force_update');

        res.json({
            isPlaying: musicQueue.isPlaying,
            currentSong: musicQueue.currentSong,
            queue: musicQueue.queue,
            currentPosition: player ? player.position : 0,
            volume: player ? player.volume : 50,
            isPaused: player ? player.paused : false
        });
    } catch (error) {
        console.error('Error getting music status:', error);
        res.status(500).json({ error: 'Failed to get music status' });
    }
});

// Music control endpoints
router.post('/dashboard/:guildId/music/play', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;
    let { url, channelId } = req.body;

    console.log(`Received music play request: URL="${url}", ChannelId="${channelId}"`);

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const channel = guild.channels.cache.get(channelId);
        if (!channel || channel.type !== 2) {
            return res.status(400).json({ error: 'Invalid voice channel selected' });
        }

        if (!url || !url.trim()) {
            return res.status(400).json({ error: 'URL or search term is required' });
        }

        url = url.trim();

        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        let searchQuery = url;
        if (!url.startsWith('http')) {
            searchQuery = `ytsearch:${url}`;
        }

        console.log(`Searching with Lavalink: ${searchQuery}`);

        try {
            // Use the first available node to search
            const nodes = managerInstance.nodeManager.nodes;
            if (nodes.size === 0) {
                return res.status(500).json({ error: 'No Lavalink nodes available' });
            }

            const node = nodes.values().next().value;
            const result = await node.search({
                query: searchQuery,
                requester: {
                    id: req.user.id,
                    username: req.user.username,
                    discriminator: req.user.discriminator || '0000',
                    tag: `${req.user.username}#${req.user.discriminator || '0000'}`,
                    originalRequester: req.user.username
                }
            });

            if (!result || !result.tracks || result.tracks.length === 0) {
                return res.status(400).json({ error: 'No songs found for your search. Please try different keywords.' });
            }

            // Use the exact track from the direct URL search
            let track = result.tracks[0];

            // Only fall back to title search if the direct URL search completely failed
            // This ensures we play the exact YouTube video that was requested

            // Helper function to format duration
            function formatDuration(seconds) {
                if (!seconds || seconds < 0) return '0:00';
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
            }

            const trackDuration = track.info.length; // This is in milliseconds

            // Store original requester info in the track object for preservation
            track.originalRequester = req.user.username;
            if (track.info) {
                track.info.originalRequester = req.user.username;
            }

            const song = {
                title: track.info.title,
                url: track.info.uri,
                duration: Math.floor(trackDuration / 1000),
                formattedDuration: formatDuration(trackDuration),
                thumbnail: track.info.artworkUrl || track.info.artwork || null,
                requestedBy: req.user.username, // Use authenticated user's username directly
                track: track
            };

            console.log('Adding song to queue:', song.title);

            const musicQueue = getMusicQueue(guildId);
            musicQueue.queue.push(song);
            musicQueue.voiceChannel = channelId;

            // Check if player exists and is active
            const existingPlayer = managerInstance.getPlayer(guildId);

            if (!musicQueue.isPlaying && !musicQueue.currentSong) {
                // No music playing, start fresh
                console.log('Starting playback...');
                await playNextSong(guildId, wss);
            } else if (existingPlayer && existingPlayer.connected) {
                // Music is playing, add to Lavalink queue
                try {
                    await existingPlayer.queue.add(song.track);
                    console.log(`Added "${song.title}" to Lavalink queue. Queue size now: ${existingPlayer.queue.size}`);

                    // Sync the app queue with Lavalink queue
                    try {
                        const lavalinkTracks = [];
                        if (existingPlayer.queue && existingPlayer.queue.tracks && Array.isArray(existingPlayer.queue.tracks)) {
                            lavalinkTracks.push(...existingPlayer.queue.tracks);
                        } else if (existingPlayer.queue && existingPlayer.queue.length > 0) {
                            // Try alternative queue access
                            for (let i = 0; i < existingPlayer.queue.length; i++) {
                                if (existingPlayer.queue[i]) {
                                    lavalinkTracks.push(existingPlayer.queue[i]);
                                }
                            }
                        }

                        console.log(`Found ${lavalinkTracks.length} tracks in Lavalink queue after adding`);

                        musicQueue.queue = lavalinkTracks.map(lavalinkTrack => ({
                            title: lavalinkTrack.info.title,
                            url: lavalinkTrack.info.uri,
                            duration: Math.floor(lavalinkTrack.info.length / 1000),
                            thumbnail: lavalinkTrack.info.artworkUrl,
                            requestedBy: req.user.username, // Use authenticated user for all queue items
                            track: lavalinkTrack
                        }));
                        console.log(`Synced app queue after adding song: ${musicQueue.queue.length} songs`);
                    } catch (syncError) {
                        console.error('Error syncing queue after adding song:', syncError);
                    }
                } catch (queueError) {
                    console.error('Error adding to Lavalink queue:', queueError.message);
                    // Remove from app queue if Lavalink add failed
                    musicQueue.queue.pop();
                    return res.status(500).json({ error: 'Failed to add song to queue: ' + queueError.message });
                }
            }

            broadcastMusicUpdate(guildId, musicQueue, wss);

            // Log music activity
            const moderator = {
                id: req.user.id,
                tag: `${req.user.username}#${req.user.discriminator || '0000'}`
            };
            await logAction(guildId, 'MUSIC_PLAY', moderator, null, `Added "${song.title}" to music queue`, {
                channelName: channel.name
            }, wss);

            res.json({
                success: true,
                message: `Added "${song.title}" to queue`,
                song
            });

        } catch (searchError) {
            console.error('Lavalink search error:', searchError);
            return res.status(500).json({ error: 'Failed to search for songs. Please try again.' });
        }

    } catch (error) {
        console.error('Music play error:', error);
        res.status(500).json({
            error: 'Internal server error while processing your request',
            details: error.message
        });
    }
});

// Music queue management endpoints
router.get('/dashboard/:guildId/music/queue', ensureDjOrAdmin, (req, res) => {
    const { guildId } = req.params;

    try {
        const musicQueue = getMusicQueue(guildId);
        res.json({
            success: true,
            queue: musicQueue.queue,
            currentSong: musicQueue.currentSong,
            isPlaying: musicQueue.isPlaying,
            volume: musicQueue.volume
        });
    } catch (error) {
        console.error('Error fetching music queue:', error);
        res.status(500).json({ error: 'Failed to fetch music queue' });
    }
});

router.post('/dashboard/:guildId/music/skip', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        if (!player.connected) {
            return res.status(400).json({ error: 'Player not connected to voice channel' });
        }

        const musicQueue = getMusicQueue(guildId);
        if (!musicQueue.currentSong && musicQueue.queue.length === 0) {
            return res.status(400).json({ error: 'No songs to skip' });
        }

        // Get queue sizes from multiple sources for better accuracy
        const lavalinkQueueSize = player.queue ? (player.queue.size || player.queue.length || 0) : 0;
        const lavalinkTracks = player.queue?.tracks ? player.queue.tracks.length : 0;
        const totalLavalinkQueue = Math.max(lavalinkQueueSize, lavalinkTracks);

        console.log(`Attempting skip - Lavalink queue size: ${totalLavalinkQueue}, App queue size: ${musicQueue.queue.length}`);

        // Check both Lavalink queue and app queue for songs
        const hasNextSong = totalLavalinkQueue > 0 || musicQueue.queue.length > 0;

        if (!hasNextSong) {
            // No songs in queue to skip to, but keep current song playing
            console.log('No songs in queue to skip to, keeping current song playing');
            res.json({
                success: true,
                message: 'No more songs in queue, continuing current song',
                nextSong: musicQueue.currentSong?.title || 'Current song'
            });
            return;
        }

        // There are songs to skip to, try to skip
        try {
            await player.skip();

            // Log skip action
            const moderator = {
                id: req.user.id,
                tag: `${req.user.username}#${req.user.discriminator || '0000'}`
            };
            await logAction(guildId, 'MUSIC_SKIP', moderator, null, 'Skipped current song via dashboard', {}, wss);

            res.json({
                success: true,
                message: 'Skipped current song',
                nextSong: player.queue.current?.info?.title || 'Next song'
            });
        } catch (skipError) {
            console.error('Lavalink skip error:', skipError.message);

            // Handle common skip errors
            if (skipError.message && (skipError.message.includes('queue size') || skipError.message.includes('Can\'t skip'))) {
                console.log('Queue size error detected, attempting to stop current track');
                try {
                    await player.stopTrack();
                    res.json({
                        success: true,
                        message: 'Skipped to next song (stopped current track)',
                        nextSong: 'Next song'
                    });
                } catch (stopError) {
                    console.error('Stop track failed:', stopError.message);
                    // Last resort - destroy and restart
                    try {
                        await player.destroy();
                        musicQueue.currentSong = null;
                        musicQueue.isPlaying = false;
                        broadcastMusicUpdate(guildId, musicQueue, wss);

                        res.json({
                            success: true,
                            message: 'Player restarted (skip error recovery)',
                            nextSong: null
                        });
                    } catch (destroyError) {
                        console.error('Failed to destroy player:', destroyError.message);
                        res.status(500).json({
                            success: false,
                            error: 'Failed to skip song: ' + skipError.message
                        });
                    }
                }
            } else {
                throw skipError; // Re-throw if it's not a queue size error
            }
        }
    } catch (error) {
        console.error('Skip operation failed:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to skip song: ' + error.message
        });
    }
});

router.post('/dashboard/:guildId/music/pause', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        if (!player.connected) {
            return res.status(400).json({ error: 'Player not connected to voice channel' });
        }

        const musicQueue = getMusicQueue(guildId);

        // Check the actual player state from lavalink instead of relying on our internal state
        const actualPlayerState = player.paused;

        console.log(`Player state check - Internal isPlaying: ${musicQueue.isPlaying}, Lavalink paused: ${actualPlayerState}`);

        if (!actualPlayerState) {
            // Player is currently playing (not paused), so pause it
            try {
                await player.pause(true);
                musicQueue.isPlaying = false;
                broadcastMusicUpdate(guildId, musicQueue, wss);
                console.log(`Successfully paused player for guild ${guildId}`);
                res.json({
                    success: true,
                    message: 'Paused playback',
                    paused: true,
                    isPlaying: false
                });
            } catch (pauseError) {
                console.error(`Error pausing player:`, pauseError.message);
                if (pauseError.message && pauseError.message.includes('already paused')) {
                    // Player is already paused, sync our state
                    musicQueue.isPlaying = false;
                    broadcastMusicUpdate(guildId, musicQueue, wss);
                    res.json({
                        success: true,
                        message: 'Already paused',
                        paused: true,
                        isPlaying: false
                    });
                } else {
                    throw pauseError;
                }
            }
        } else {
            // Player is currently paused, so resume it
            try {
                await player.pause(false);
                musicQueue.isPlaying = true;
                broadcastMusicUpdate(guildId, musicQueue, wss);
                console.log(`Successfully resumed player for guild ${guildId}`);
                res.json({
                    success: true,
                    message: 'Resumed playback',
                    paused: false,
                    isPlaying: true
                });
            } catch (resumeError) {
                console.error(`Error resuming player:`, resumeError.message);
                if (resumeError.message && (resumeError.message.includes('not paused') || resumeError.message.includes('already playing'))) {
                    // Player is already playing, sync our state
                    musicQueue.isPlaying = true;
                    broadcastMusicUpdate(guildId, musicQueue, wss);
                    res.json({
                        success: true,
                        message: 'Already playing',
                        paused: false,
                        isPlaying: true
                    });
                } else {
                    throw resumeError;
                }
            }
        }
    } catch (error) {
        console.error('Error pausing/resuming:', error);
        res.status(500).json({ error: 'Failed to pause/resume: ' + error.message });
    }
});

router.post('/dashboard/:guildId/music/stop', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        const musicQueue = getMusicQueue(guildId);

        // Clear the queue and stop current song
        musicQueue.queue = [];
        musicQueue.currentSong = null;
        musicQueue.isPlaying = false;

        // Use destroy instead of stop for lavalink-client
        try {
            await player.destroy();
        } catch (destroyError) {
            console.log('Player destroy error (might be already destroyed):', destroyError.message);
        }

        // Log stop action
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };
        await logAction(guildId, 'MUSIC_STOP', moderator, null, 'Music stopped and queue cleared via dashboard', {}, wss);

        // Broadcast the update
        broadcastMusicUpdate(guildId, musicQueue, wss);

        res.json({
            success: true,
            message: 'Music stopped and queue cleared'
        });
    } catch (error) {
        console.error('Error stopping music:', error);
        res.status(500).json({ error: 'Failed to stop music: ' + error.message });
    }
});

// GET route for resume (for compatibility)
router.get('/dashboard/:guildId/music/resume', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        if (!player.connected) {
            return res.status(400).json({ error: 'Player not connected to voice channel' });
        }

        const musicQueue = getMusicQueue(guildId);

        console.log(`Resume request - Internal state: ${musicQueue.isPlaying}, Lavalink paused: ${player.paused}`);

        if (!player.paused) {
            // Player is already playing, sync our state
            musicQueue.isPlaying = true;
            broadcastMusicUpdate(guildId, musicQueue, wss);
            return res.json({
                success: true,
                message: 'Already playing',
                paused: false,
                isPlaying: true
            });
        }

        // Player is paused, so resume it
        await player.resume();
        musicQueue.isPlaying = true;
        broadcastMusicUpdate(guildId, musicQueue, wss);

        res.json({
            success: true,
            message: 'Resumed playback',
            paused: false,
            isPlaying: true
        });
    } catch (error) {
        console.error('Error resuming music:', error);
        res.status(500).json({ error: 'Failed to resume music: ' + error.message });
    }
});

router.post('/dashboard/:guildId/music/resume', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const managerInstance = manager();
        if (!managerInstance) {
            return res.status(500).json({ error: 'Lavalink not initialized' });
        }

        const player = managerInstance.getPlayer(guildId);
        if (!player) {
            return res.status(400).json({ error: 'No active player found. Start playing music first.' });
        }

        if (!player.connected) {
            return res.status(400).json({ error: 'Player not connected to voice channel' });
        }

        const musicQueue = getMusicQueue(guildId);

        console.log(`Resume request - Internal state: ${musicQueue.isPlaying}, Lavalink paused: ${player.paused}`);

        if (!player.paused) {
            // Player is already playing, sync our state
            musicQueue.isPlaying = true;
            broadcastMusicUpdate(guildId, musicQueue, wss);
            return res.json({
                success: true,
                message: 'Already playing',
                paused: false,
                isPlaying: true
            });
        }

        // Player is paused, so resume it
        await player.resume();
        musicQueue.isPlaying = true;
        broadcastMusicUpdate(guildId, musicQueue, wss);

        res.json({
            success: true,
            message: 'Resumed playback',
            paused: false,
            isPlaying: true
        });
    } catch (error) {
        console.error('Error resuming music:', error);
        res.status(500).json({ error: 'Failed to resume music: ' + error.message });
    }
});

router.post('/dashboard/:guildId/music/volume', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;
    const { volume } = req.body;

    if (typeof volume !== 'number' || volume < 0 || volume > 100) {
        return res.status(400).json({ error: 'Volume must be between 0 and 100' });
    }

    try {
        const managerInstance = manager();
        const musicQueue = getMusicQueue(guildId);

        // Update the queue's volume setting
        musicQueue.volume = volume;

        if (managerInstance) {
            const player = managerInstance.getPlayer(guildId);
            if (player && player.connected) {
                await player.setVolume(volume);
                console.log(`Volume set to ${volume}% for guild ${guildId}`);
            } else if (player) {
                console.log(`Volume will be set to ${volume}% when player connects for guild ${guildId}`);
            }
        }

        // Log volume change
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };
        await logAction(guildId, 'MUSIC_VOLUME', moderator, null, `Volume changed to ${volume}%`, {}, wss);

        // Broadcast the update to all connected WebSocket clients
        broadcastMusicUpdate(guildId, musicQueue, wss, 'volume_only');

        res.json({
            success: true,
            message: `Volume set to ${volume}%`,
            volume: volume,
            playerConnected: managerInstance ?
                (managerInstance.getPlayer(guildId)?.connected || false) : false
        });
    } catch (error) {
        console.error('Error setting volume:', error);
        res.status(500).json({ error: 'Failed to set volume: ' + error.message });
    }
});

router.delete('/dashboard/:guildId/music/queue/:index', ensureDjOrAdmin, (req, res) => {
    const { guildId, index } = req.params;

    try {
        const musicQueue = getMusicQueue(guildId);
        const queueIndex = parseInt(index);

        if (isNaN(queueIndex) || queueIndex < 0 || queueIndex >= musicQueue.queue.length) {
            return res.status(400).json({ error: 'Invalid queue index' });
        }

        const removedSong = musicQueue.queue.splice(queueIndex, 1)[0];
        broadcastMusicUpdate(guildId, musicQueue, wss);

        res.json({
            success: true,
            message: `Removed "${removedSong.title}" from queue`
        });
    } catch (error) {
        console.error('Error removing song from queue:', error);
        res.status(500).json({ error: 'Failed to remove song from queue' });
    }
});

// Get current playback position
router.get('/dashboard/:guildId/music/position', ensureDjOrAdmin, async (req, res) => {
    const { guildId } = req.params;

    try {
        const musicQueue = getMusicQueue(guildId);
        const managerInstance = manager();
        let position = 0;
        let duration = 0;
        let isPlaying = false;

        if (managerInstance) {
            const player = managerInstance.getPlayer(guildId);
            if (player && player.connected && player.queue && player.queue.current) {
                position = player.position || 0;
                duration = player.queue.current.info.length || 0;
                isPlaying = !player.paused;
            }
        }

        // Get duration from current song if available
        if (musicQueue.currentSong && musicQueue.currentSong.duration) {
            duration = musicQueue.currentSong.duration * 1000; // Convert to milliseconds
        }

        res.json({
            success: true,
            position: Math.floor(position / 1000), // Convert to seconds
            duration: Math.floor(duration / 1000), // Convert to seconds
            isPlaying: isPlaying,
            currentSong: musicQueue.currentSong
        });
    } catch (error) {
        console.error('Error getting position:', error);
        res.status(500).json({ error: 'Failed to get position' });
    }
});

// Music position endpoint for direct access
router.get('/music/position', ensureAuthenticated, async (req, res) => {
    const guildId = req.query.guildId;

    if (!guildId) {
        return res.status(400).json({ error: 'Guild ID is required' });
    }

    // Check if user has access to this guild
    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    try {
        const musicQueue = getMusicQueue(guildId);
        const managerInstance = manager();
        let position = 0;
        let duration = 0;
        let isPlaying = false;

        if (managerInstance) {
            const player = managerInstance.getPlayer(guildId);
            if (player && player.connected && player.queue && player.queue.current) {
                position = player.position || 0;
                duration = player.queue.current.info.length || 0;
                isPlaying = !player.paused;
            }
        }

        // Get duration from current song if available
        if (musicQueue.currentSong && musicQueue.currentSong.duration) {
            duration = musicQueue.currentSong.duration * 1000; // Convert to milliseconds
        }

        res.json({
            success: true,
            position: Math.floor(position / 1000), // Convert to seconds
            duration: Math.floor(duration / 1000), // Convert to seconds
            isPlaying: isPlaying,
            currentSong: musicQueue.currentSong
        });
    } catch (error) {
        console.error('Error getting position:', error);
        res.status(500).json({ error: 'Failed to get position' });
    }
});

// Get guild roles
router.get('/dashboard/:guildId/roles', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access roles API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to view roles' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const roles = guild.roles.cache
            .filter(role => role.id !== guild.id) // Exclude @everyone role
            .map(role => ({
                id: role.id,
                name: role.name,
                color: role.hexColor,
                position: role.position,
                permissions: role.permissions.bitfield.toString(),
                mentionable: role.mentionable,
                hoist: role.hoist,
                managed: role.managed,
                memberCount: role.members.size
            }))
            .sort((a, b) => b.position - a.position);

        res.json({
            success: true,
            roles: roles
        });
    } catch (error) {
        console.error('Error fetching guild roles:', error);
        res.status(500).json({ error: 'Failed to fetch guild roles' });
    }
});

// Get guild members with infinite scroll support
router.get('/dashboard/:guildId/members', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { page = 1, search = '', role = '', sort = 'newest', limit = 20, offset = 0 } = req.query;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access members API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to view members' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        // Fetch members if needed
        await guild.members.fetch({ limit: 1000, force: false });

        let members = Array.from(guild.members.cache.values());

        // Filter out bots first
        members = members.filter(member => !member.user.bot);

        // Apply search filter - ensure we handle the search parameter correctly
        console.log('Search parameter received:', search, 'Type:', typeof search, 'Length:', search ? search.length : 0);
        if (search && search.trim() !== '' && search !== 'undefined' && search !== 'null') {
            const searchTerm = search.toLowerCase().trim();
            console.log(`Applying search filter: "${searchTerm}"`);
            members = members.filter(member => {
                const username = member.user.username.toLowerCase();
                const tag = member.user.tag.toLowerCase();
                const nickname = member.nickname ? member.nickname.toLowerCase() : '';

                const matches = username.includes(searchTerm) ||
                              tag.includes(searchTerm) ||
                              nickname.includes(searchTerm);

                return matches;
            });
            console.log(`Filtered members count after search: ${members.length}`);
        }

        // Apply role filter
        if (role && role.trim() !== '' && role !== 'undefined' && role !== 'null') {
            members = members.filter(member => member.roles.cache.has(role.trim()));
        }

        // Apply sorting
        switch (sort) {
            case 'newest':
                members.sort((a, b) => b.joinedTimestamp - a.joinedTimestamp);
                break;
            case 'oldest':
                members.sort((a, b) => a.joinedTimestamp - b.joinedTimestamp);
                break;
            case 'username':
                members.sort((a, b) => a.user.username.localeCompare(b.user.username));
                break;
            default:
                members.sort((a, b) => b.joinedTimestamp - a.joinedTimestamp);
        }

        // Apply infinite scroll pagination
        const limitNum = parseInt(limit) || 20;
        const offsetNum = parseInt(offset) || 0;
        const totalMembers = members.length;
        const paginatedMembers = members.slice(offsetNum, offsetNum + limitNum);

        const membersData = paginatedMembers.map(member => ({
            id: member.user.id,
            username: member.user.username,
            nickname: member.nickname,
            tag: member.user.tag,
            avatar: member.user.displayAvatarURL(),
            joinedAt: member.joinedTimestamp,
            createdAt: member.user.createdTimestamp,
            roles: member.roles.cache
                .filter(role => role.id !== guild.id)
                .map(role => ({
                    id: role.id,
                    name: role.name,
                    color: role.hexColor
                })),
            isBot: member.user.bot,
            status: member.presence?.status || 'offline'
        }));

        const hasMore = offsetNum + limitNum < totalMembers;

        res.json({
            success: true,
            members: membersData,
            pagination: {
                current: Math.floor(offsetNum / limitNum) + 1,
                totalMembers: totalMembers,
                hasMore: hasMore,
                hasPrev: offsetNum > 0,
                offset: offsetNum,
                limit: limitNum,
                returned: membersData.length
            }
        });
    } catch (error) {
        console.error('Error fetching guild members:', error);
        res.status(500).json({ error: 'Failed to fetch guild members' });
    }
});

// Get audit logs
router.get('/dashboard/:guildId/logs', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { page = 1, limit = 50, action = '', category = '', search = '', startDate = '', endDate = '' } = req.query;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access audit logs API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to view audit logs' });
    }

    try {
        const { sequelize } = require('../config/database');
        const { Op } = require('sequelize');

        // Import AuditLog model properly - use the export from auditLogger
        const { AuditLog } = require('../utils/auditLogger');

        const whereClause = { guildId };

        // Apply filters
        if (action && action !== '') {
            whereClause.action = action;
        }
        if (category && category !== '') {
            whereClause.category = category;
        }
        if (search && search !== '') {
            whereClause[Op.or] = [
                { moderatorTag: { [Op.like]: `%${search}%` } },
                { targetTag: { [Op.like]: `%${search}%` } },
                { reason: { [Op.like]: `%${search}%` } },
                { channelName: { [Op.like]: `%${search}%` } }
            ];
        }
        if (startDate && startDate !== '') {
            if (!whereClause.timestamp) whereClause.timestamp = {};
            whereClause.timestamp[Op.gte] = new Date(startDate);
        }
        if (endDate && endDate !== '') {
            if (!whereClause.timestamp) whereClause.timestamp = {};
            const endDateTime = new Date(endDate);
            endDateTime.setHours(23, 59, 59, 999);
            whereClause.timestamp[Op.lte] = endDateTime;
        }

        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const offset = (pageNum - 1) * limitNum;

        const result = await AuditLog.findAndCountAll({
            where: whereClause,
            order: [['timestamp', 'DESC']],
            limit: limitNum,
            offset: offset
        });

        res.json({
            success: true,
            logs: result.rows,
            pagination: {
                current: pageNum,
                total: Math.ceil(result.count / limitNum),
                hasNext: offset + limitNum < result.count,
                hasPrev: pageNum > 1,
                totalLogs: result.count,
                currentPage: pageNum,
                totalPages: Math.ceil(result.count / limitNum)
            }
        });
    } catch (error) {
        console.error('Error fetching audit logs:', error);
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
});

// API endpoint to get current configuration
router.get('/dashboard/:guildId/config', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access configuration API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to view configuration' });
    }

    try {
        const config = await getOrCreateGuildConfig(guildId);

        let roleConfigs = config.roleConfigs;
        if (typeof roleConfigs === 'string') {
            try {
                roleConfigs = JSON.parse(roleConfigs);
            } catch (parseError) {
                console.error('Error parsing roleConfigs JSON:', parseError);
                roleConfigs = [];
            }
        }

        if (!Array.isArray(roleConfigs)) {
            roleConfigs = [];
        }

        res.json({
            success: true,
            config: {
                prefix: config.prefix,
                logChannel: config.logChannel,
                specialSuffix: config.specialSuffix,
                roleConfigs: roleConfigs
            }
        });
    } catch (error) {
        console.error('Error fetching configuration:', error);
        res.status(500).json({ error: 'Failed to fetch configuration' });
    }
});

// API endpoint to update configuration
router.post('/dashboard/:guildId/config', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { prefix, logChannel, specialSuffix, roleConfigs } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only special role OR Discord admin permissions can access configuration API
    if (!req.userRole || (!req.userRole.hasSpecialRole && !req.userRole.hasDiscordAdminPerms)) {
        return res.status(403).json({ error: 'You need Access role or Discord Administrator/Manage Server permissions to update configuration' });
    }

    try {
        const config = await getOrCreateGuildConfig(guildId);

        if (prefix !== undefined) {
            config.prefix = prefix;
        }
        if (logChannel !== undefined) {
            config.logChannel = logChannel;
        }
        if (specialSuffix !== undefined) {
            config.specialSuffix = specialSuffix;
        }
        if (roleConfigs !== undefined) {
            const newRoleConfigs = Array.isArray(roleConfigs) ? roleConfigs : [];

            // Check if role configs actually changed
            const oldConfigsStr = JSON.stringify(config.roleConfigs);
            const newConfigsStr = JSON.stringify(newRoleConfigs);

            if (oldConfigsStr !== newConfigsStr) {
                config.roleConfigs = newRoleConfigs;
            }
        }

        await config.save();

        // If role configurations changed, apply to all members with configured roles
        if (config.changedProperties && config.changedProperties.includes('roleConfigs')) {
            const { updateAllMembersWithConfiguredRoles } = require('../utils/guildUtils');

            // Parse the new role configs
            let parsedRoleConfigs = config.roleConfigs;
            if (typeof parsedRoleConfigs === 'string') {
                try {
                    parsedRoleConfigs = JSON.parse(parsedRoleConfigs);
                } catch (parseError) {
                    console.error('Error parsing roleConfigs JSON:', parseError);
                    parsedRoleConfigs = [];
                }
            }

            // Apply changes to all members with configured roles
            await updateAllMembersWithConfiguredRoles(guild, parsedRoleConfigs);
        }

        // Log the configuration update
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        const logMessage = config.changedProperties && config.changedProperties.includes('roleConfigs') ?
            'Configuration updated and applied to all relevant members via dashboard' :
            'Configuration updated via dashboard';

        await logAction(guildId, 'BOT_CONFIG_UPDATE', moderator, null, logMessage, {}, wss);

        res.json({
            success: true,
            message: config.changedProperties && config.changedProperties.includes('roleConfigs') ?
                'Configuration updated and applied to all relevant members' :
                'Configuration updated successfully',
            config: {
                prefix: config.prefix,
                logChannel: config.logChannel,
                specialSuffix: config.specialSuffix,
                roleConfigs: config.roleConfigs
            }
        });
    } catch (error) {
        console.error('Error updating configuration:', error);
        res.status(500).json({ error: 'Failed to update configuration' });
    }
});

// Moderation actions (kick/ban with approval)
router.post('/dashboard/:guildId/moderate', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { action, memberId, reason, deleteMessages } = req.body;

    try {
        // Verify user has admin permissions for moderation actions
        if (!req.userRole || !req.userRole.hasAdminPermissions) {
            return res.status(403).json({
                success: false,
                error: 'You need administrator permissions to perform moderation actions.'
            });
        }

        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({
                success: false,
                error: 'Guild not found'
            });
        }

        // Get target member
        const targetMember = await guild.members.fetch(memberId).catch(() => null);
        if (!targetMember) {
            return res.status(404).json({
                success: false,
                error: 'Member not found in this server'
            });
        }

        // Validate action
        if (!['kick', 'ban'].includes(action)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid moderation action'
            });
        }

        // Get approval channel (you may want to store this in guild config)
        const approvalChannelId = '1218176257146228827'; // Replace with your approval channel ID
        const approvalChannel = guild.channels.cache.get(approvalChannelId);

        if (!approvalChannel) {
            return res.status(500).json({
                success: false,
                error: 'Approval channel not found. Please contact an administrator.'
            });
        }

        // Import and use approval system
        const { sendApprovalRequest } = require('../utils/approvalSystem');

        const requestData = {
            type: action,
            guildId: guildId,
            targetId: memberId,
            targetUsername: targetMember.user.username,
            targetTag: targetMember.user.tag,
            requesterId: req.user.id,
            requesterTag: `${req.user.username}#${req.user.discriminator}`,
            reason: reason,
            deleteMessages: deleteMessages || false
        };

        await sendApprovalRequest(approvalChannel, requestData);

        // Log the approval request
        const { logAction } = require('../utils/auditLogger');
        await logAction(guildId, `${action.toUpperCase()}_REQUEST`, {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator}`
        }, {
            id: memberId,
            tag: targetMember.user.tag
        }, `Approval requested: ${reason}`, {});

        res.json({
            success: true,
            message: `${action.charAt(0).toUpperCase() + action.slice(1)} request sent for approval`
        });

    } catch (error) {
        console.error('Error processing moderation request:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Member management API endpoints
router.post('/dashboard/:guildId/member/:memberId/role', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { roleId, action } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can manage roles
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to manage roles' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const member = await guild.members.fetch(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        const role = guild.roles.cache.get(roleId);
        if (!role) {
            return res.status(404).json({ error: 'Role not found' });
        }

        // Check if the bot can manage this role
        const botMember = guild.members.me;
        if (role.position >= botMember.roles.highest.position) {
            return res.status(403).json({ error: 'Cannot manage role: Role is higher than or equal to bot\'s highest role' });
        }

        // Check if the user trying to manage the role has permission
        const userMember = await guild.members.fetch(req.user.id);
        if (role.position >= userMember.roles.highest.position && guild.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Cannot manage role: Role is higher than or equal to your highest role' });
        }

        let actionTaken = '';
        if (action === 'add') {
            if (member.roles.cache.has(roleId)) {
                return res.status(400).json({ error: 'Member already has this role' });
            }
            await member.roles.add(roleId);
            actionTaken = 'added';
        } else if (action === 'remove') {
            if (!member.roles.cache.has(roleId)) {
                return res.status(400).json({ error: 'Member does not have this role' });
            }
            await member.roles.remove(roleId);
            actionTaken = 'removed';
        } else {
            return res.status(400).json({ error: 'Invalid action. Use "add" or "remove"' });
        }

        // Log the role change
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, action === 'add' ? 'ROLE_ADD' : 'ROLE_REMOVE', moderator, member.user,
            `Role ${actionTaken}: ${role.name}`, {}, wss);

        res.json({
            success: true,
            message: `Role ${role.name} ${actionTaken} successfully`,
            action: actionTaken,
            role: {
                id: role.id,
                name: role.name
            }
        });
    } catch (error) {
        console.error('Error managing member role:', error);
        res.status(500).json({ error: 'Failed to manage member role: ' + error.message });
    }
});

router.post('/dashboard/:guildId/member/:memberId/nickname', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { nickname } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can change nicknames
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to change nicknames' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const member = await guild.members.fetch(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        const userMember = await guild.members.fetch(req.user.id);
        if (member.roles.highest.position >= userMember.roles.highest.position && guild.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Cannot change nickname: Member has higher or equal roles to you' });
        }

        const newNickname = nickname && nickname.trim() ? nickname.trim() : null;

        await member.setNickname(newNickname);

        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'NICKNAME_CHANGE', moderator, member.user, `Nickname changed to: ${newNickname || 'None'}`, {}, wss);

        res.json({
            success: true,
            message: 'Nickname updated successfully',
            nickname: newNickname
        });
    } catch (error) {
        console.error('Error updating nickname:', error);
        res.status(500).json({ error: 'Failed to update nickname: ' + error.message });
    }
});

router.post('/dashboard/:guildId/member/:memberId/kick', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { reason } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can kick members
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to kick members' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const member = await guild.members.fetch(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        // Check if we can kick this member
        if (member.id === guild.ownerId) {
            return res.status(403).json({ error: 'Cannot kick server owner' });
        }

        const botMember = guild.members.me;
        if (member.roles.highest.position >= botMember.roles.highest.position) {
            return res.status(403).json({ error: 'Cannot kick member: Member has higher or equal roles to bot' });
        }

        const userMember = await guild.members.fetch(req.user.id);
        if (member.roles.highest.position >= userMember.roles.highest.position && guild.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Cannot kick member: Member has higher or equal roles to you' });
        }

        const kickReason = reason && reason.trim() ? reason.trim() : 'No reason provided';

        await member.kick(kickReason);

        // Log the kick
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'MEMBER_KICK', moderator, member.user, kickReason, {}, wss);

        res.json({
            success: true,
            message: 'Member kicked successfully',
            reason: kickReason
        });
    } catch (error) {
        console.error('Error kicking member:', error);
        res.status(500).json({ error: 'Failed to kick member: ' + error.message });
    }
});

// Manual refresh endpoint for all member nicknames
router.post('/dashboard/:guildId/refresh-nicknames', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can refresh nicknames
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to refresh nicknames' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        // Get current configuration
        const config = await getOrCreateGuildConfig(guildId);
        if (!config || !config.roleConfigs) {
            return res.status(400).json({ error: 'No role configuration found' });
        }

        // Parse roleConfigs
        let roleConfigs = config.roleConfigs;
        if (typeof roleConfigs === 'string') {
            try {
                roleConfigs = JSON.parse(roleConfigs);
            } catch (parseError) {
                return res.status(400).json({ error: 'Invalid roleConfigs format' });
            }
        }

        // Update all members with configured roles
        const { updateAllMembersWithConfiguredRoles } = require('../utils/guildUtils');
        await updateAllMembersWithConfiguredRoles(guild, roleConfigs);

        // Log the manual refresh
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'NICKNAME_REFRESH', moderator, null, 'Manual nickname refresh triggered via dashboard', {}, wss);

        res.json({
            success: true,
            message: 'All member nicknames have been refreshed'
        });

    } catch (error) {
        console.error('Error refreshing member nicknames:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/dashboard/:guildId/member/:memberId/kick-request', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { reason } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can request kicks
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to request member kicks' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        const member = await guild.members.fetch(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        // Basic checks
        if (member.id === guild.ownerId) {
            return res.status(403).json({ error: 'Cannot kick server owner' });
        }

        const kickReason = reason && reason.trim() ? reason.trim() : 'No reason provided';

        // Send approval request to designated channel
        const approvalChannelId = '1412210403701817446';
        const approvalChannel = guild.channels.cache.get(approvalChannelId);

        if (!approvalChannel) {
            return res.status(500).json({ error: 'Approval channel not found' });
        }

        const { sendApprovalRequest } = require('../utils/approvalSystem');
        await sendApprovalRequest(approvalChannel, {
            type: 'kick',
            guildId: guildId,
            targetId: memberId,
            targetUsername: member.user.username,
            targetTag: member.user.tag,
            requesterId: req.user.id,
            requesterTag: `${req.user.username}#${req.user.discriminator || '0000'}`,
            reason: kickReason
        });

        res.json({
            success: true,
            message: 'Kick request submitted for approval'
        });
    } catch (error) {
        console.error('Error submitting kick request:', error);
        res.status(500).json({ error: 'Failed to submit kick request: ' + error.message });
    }
});

router.post('/dashboard/:guildId/member/:memberId/ban-request', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { reason, deleteMessages } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can request bans
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to request member bans' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        let member;
        let user;

        try {
            member = await guild.members.fetch(memberId);
            user = member.user;
        } catch {
            try {
                user = await client.users.fetch(memberId);
            } catch {
                return res.status(404).json({ error: 'User not found' });
            }
        }

        // Basic checks
        if (member && member.id === guild.ownerId) {
            return res.status(403).json({ error: 'Cannot ban server owner' });
        }

        const banReason = reason && reason.trim() ? reason.trim() : 'No reason provided';

        // Send approval request to designated channel
        const approvalChannelId = '1412210403701817446';
        const approvalChannel = guild.channels.cache.get(approvalChannelId);

        if (!approvalChannel) {
            return res.status(500).json({ error: 'Approval channel not found' });
        }

        const { sendApprovalRequest } = require('../utils/approvalSystem');
        await sendApprovalRequest(approvalChannel, {
            type: 'ban',
            guildId: guildId,
            targetId: memberId,
            targetUsername: user.username,
            targetTag: user.tag,
            requesterId: req.user.id,
            requesterTag: `${req.user.username}#${req.user.discriminator || '0000'}`,
            reason: banReason,
            deleteMessages: deleteMessages || false
        });

        res.json({
            success: true,
            message: 'Ban request submitted for approval'
        });
    } catch (error) {
        console.error('Error submitting ban request:', error);
        res.status(500).json({ error: 'Failed to submit ban request: ' + error.message });
    }
});

router.post('/dashboard/:guildId/member/:memberId/ban', ensureRole, async (req, res) => {
    const { guildId, memberId } = req.params;
    const { reason, deleteMessages } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    // Only users with BOTH Access role AND Discord admin permissions can ban members
    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need both the Access role AND Discord Administrator/Manage Server permissions to ban members' });
    }

    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        let member;
        let user;

        try {
            member = await guild.members.fetch(memberId);
            user = member.user;
        } catch {
            // Member might not be in guild, try to get user directly
            try {
                user = await client.users.fetch(memberId);
            } catch {
                return res.status(404).json({ error: 'User not found' });
            }
        }

        // Check if we can ban this member (if they're in the guild)
        if (member) {
            if (member.id === guild.ownerId) {
                return res.status(403).json({ error: 'Cannot ban server owner' });
            }

            const botMember = guild.members.me;
            if (member.roles.highest.position >= botMember.roles.highest.position) {
                return res.status(403).json({ error: 'Cannot ban member: Member has higher or equal roles to bot' });
            }

            const userMember = await guild.members.fetch(req.user.id);
            if (member.roles.highest.position >= userMember.roles.highest.position && guild.ownerId !== req.user.id) {
                return res.status(403).json({ error: 'Cannot ban member: Member has higher or equal roles to you' });
            }
        }

        const banReason = reason && reason.trim() ? reason.trim() : 'No reason provided';
        const deleteMessageDays = deleteMessages ? 7 : 0;

        await guild.members.ban(user, {
            reason: banReason,
            deleteMessageDays: deleteMessageDays
        });

        // Log the ban
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'MEMBER_BAN', moderator, user, banReason, {
            extra: { deleteMessages: deleteMessages }
        }, wss);

        res.json({
            success: true,
            message: 'Member banned successfully',
            reason: banReason,
            deleteMessages: deleteMessages
        });
    } catch (error) {
        console.error('Error banning member:', error);
        res.status(500).json({ error: 'Failed to ban member: ' + error.message });
    }
});

// Content moderation endpoints
router.get('/dashboard/:guildId/content-moderation/settings', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need administrator permissions to view content moderation settings' });
    }

    try {
        const { ContentModerationConfig } = require('../config/database');

        const config = await ContentModerationConfig.findOne({
            where: { guildId }
        });

        // Load custom words from BadWord table
        const { BadWord } = require('../config/database');
        const customBadWords = await BadWord.findAll({
            where: {
                guildId: guildId,
                language: 'custom',
                isActive: true
            },
            attributes: ['word']
        });

        const customWordsArray = customBadWords.map(bw => bw.word);

        const data = config ? {
            enableModeration: config.enableModeration,
            enableGeorgian: config.enableGeorgian,
            actionType: config.actionType,
            sensitivityLevel: config.sensitivityLevel,
            customWords: customWordsArray,
            monitoredChannels: Array.isArray(config.monitoredChannels) ? config.monitoredChannels : [],
            excludedRoles: Array.isArray(config.excludedRoles) ? config.excludedRoles : [],
            logChannel: config.logChannel
        } : {
            enableModeration: true,
            enableGeorgian: true,
            actionType: 'warn',
            sensitivityLevel: 'medium',
            customWords: [],
            monitoredChannels: [],
            excludedRoles: [],
            logChannel: null
        };

        console.log('Loaded settings for guild', guildId, ':', data);

        res.json({
            success: true,
            data
        });
    } catch (error) {
        console.error('Error loading content moderation settings:', error);
        res.status(500).json({ error: 'Failed to load settings' });
    }
});

router.post('/dashboard/:guildId/content-moderation/settings', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { enableModeration, enableGeorgian, actionType, sensitivityLevel, customWords, monitoredChannels, excludedRoles, logChannel } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need administrator permissions to modify content moderation settings' });
    }

    try {
        const { ContentModerationConfig } = require('../config/database');

        console.log('Saving settings for guild', guildId, ':', {
            enableModeration,
            enableGeorgian,
            actionType,
            sensitivityLevel,
            customWords,
            monitoredChannels,
            excludedRoles
        });

        // Ensure arrays are properly formatted
        const safeCustomWords = Array.isArray(customWords) ? customWords.filter(word => word && word.trim()) : [];
        const safeMonitoredChannels = Array.isArray(monitoredChannels) ? monitoredChannels : [];
        const safeExcludedRoles = Array.isArray(excludedRoles) ? excludedRoles : [];

        const [config, created] = await ContentModerationConfig.upsert({
            guildId,
            enableModeration: enableModeration !== undefined ? enableModeration : true,
            enableGeorgian: enableGeorgian !== undefined ? enableGeorgian : true,
            actionType: actionType || 'warn',
            sensitivityLevel: sensitivityLevel || 'medium',
            customWords: safeCustomWords,
            monitoredChannels: safeMonitoredChannels,
            excludedRoles: safeExcludedRoles,
            logChannel: logChannel || null
        });

        console.log('Database config saved:', config.toJSON());

        // Save custom words as bad words in database
        const moderationSystem = require('../utils/contentModerationSystem');
        
        // Remove existing custom words for this guild
        const { BadWord } = require('../config/database');
        await BadWord.destroy({
            where: {
                guildId: guildId,
                language: 'custom'
            }
        });

        // Add new custom words
        for (const word of safeCustomWords) {
            if (word && word.trim()) {
                await moderationSystem.addBadWord(
                    word.trim(),
                    'custom',
                    'medium',
                    guildId,
                    `${req.user.username}#${req.user.discriminator || '0000'}`
                );
            }
        }

        // Update the moderation system with new settings
        moderationSystem.saveGuildSettings(guildId, {
            enableModeration: config.enableModeration,
            enableGeorgian: config.enableGeorgian,
            actionType: config.actionType,
            sensitivityLevel: config.sensitivityLevel,
            customWords: config.customWords,
            monitoredChannels: config.monitoredChannels,
            excludedRoles: config.excludedRoles
        });

        console.log('Moderation system updated with new settings');

        // Log the configuration update
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'CONTENT_MODERATION_UPDATE', moderator, null, 'Content moderation settings updated via dashboard', {}, wss);

        res.json({
            success: true,
            message: 'Content moderation settings saved successfully'
        });
    } catch (error) {
        console.error('Error saving content moderation settings:', error);
        res.status(500).json({ error: 'Failed to save settings: ' + error.message });
    }
});

router.post('/dashboard/:guildId/content-moderation/test', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { message, sensitivity, enableGeorgian } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need administrator permissions to test content moderation' });
    }

    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'Message is required and must be a string' });
    }

    try {
        const moderationSystem = require('../utils/contentModerationSystem');

        const result = await moderationSystem.analyzeContent(message, {
            sensitivity: sensitivity || 'medium',
            enableGeorgian: enableGeorgian !== undefined ? enableGeorgian : true,
            guildId
        });

        // Ensure the response has all required fields
        const response = {
            isClean: result.isClean || false,
            detectedWords: result.detectedWords || [],
            detectedDetails: result.detectedDetails || [],
            severity: result.severity || 'low',
            confidence: result.confidence || 0,
            action: result.action || 'warn',
            analysisMethod: result.analysisMethod || 'deep_custom_analysis'
        };

        res.json(response);
    } catch (error) {
        console.error('Error testing content moderation:', error);
        res.status(500).json({
            error: 'Failed to test content',
            details: error.message
        });
    }
});

// Get bad words for a guild
router.get('/dashboard/:guildId/content-moderation/bad-words', ensureRole, async (req, res) => {
    const { guildId } = req.params;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need administrator permissions to view bad words' });
    }

    try {
        const moderationSystem = require('../utils/contentModerationSystem');
        const badWords = await moderationSystem.getBadWordsForGuild(guildId);

        res.json({
            success: true,
            data: badWords
        });
    } catch (error) {
        console.error('Error loading bad words:', error);
        res.status(500).json({ error: 'Failed to load bad words' });
    }
});

// Add bad word
router.post('/dashboard/:guildId/content-moderation/bad-words', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { word, severity } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need administrator permissions to add bad words' });
    }

    if (!word || !word.trim()) {
        return res.status(400).json({ error: 'Word is required' });
    }

    if (!['low', 'medium', 'high'].includes(severity)) {
        return res.status(400).json({ error: 'Invalid severity level. Must be low, medium, or high' });
    }

    try {
        const moderationSystem = require('../utils/contentModerationSystem');

        await moderationSystem.addBadWord(
            word.trim(),
            'custom',
            severity,
            guildId,
            `${req.user.username}#${req.user.discriminator || '0000'}`
        );

        // Log the action
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'BAD_WORD_ADD', moderator, null, `Added bad word: "${word.trim()}" (${language}, ${severity})`, {}, wss);

        res.json({
            success: true,
            message: 'Bad word added successfully'
        });
    } catch (error) {
        console.error('Error adding bad word:', error);
        res.status(500).json({ error: 'Failed to add bad word' });
    }
});

// Remove bad word
router.delete('/dashboard/:guildId/content-moderation/bad-words', ensureRole, async (req, res) => {
    const { guildId } = req.params;
    const { word } = req.body;

    const userGuild = req.user.guilds.find(g => g.id === guildId);
    if (!userGuild) {
        return res.status(403).json({ error: 'Access denied' });
    }

    if (!req.userRole || !req.userRole.hasAdminPermissions) {
        return res.status(403).json({ error: 'You need administrator permissions to remove bad words' });
    }

    if (!word || !word.trim()) {
        return res.status(400).json({ error: 'Word is required' });
    }

    try {
        const moderationSystem = require('../utils/contentModerationSystem');

        const removed = await moderationSystem.removeBadWord(word.trim(), guildId);

        if (!removed) {
            return res.status(404).json({ error: 'Bad word not found' });
        }

        // Log the action
        const moderator = {
            id: req.user.id,
            tag: `${req.user.username}#${req.user.discriminator || '0000'}`
        };

        await logAction(guildId, 'BAD_WORD_REMOVE', moderator, null, `Removed bad word: "${word.trim()}"`, {}, wss);

        res.json({
            success: true,
            message: 'Bad word removed successfully'
        });
    } catch (error) {
        console.error('Error removing bad word:', error);
        res.status(500).json({ error: 'Failed to remove bad word' });
    }
});

module.exports = { router, setWebSocketServer };