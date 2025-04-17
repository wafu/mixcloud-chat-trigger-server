const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

// Application state
let browser = null;
let page = null;
let isMonitoring = false;
let mixcloudUrl = '';
let lastMessages = new Set();
let checkInterval = null;
let triggerWords = [];
let wsServer = null;
let clients = [];

// Create express app for control API
const expressApp = express();
expressApp.use(cors());
expressApp.use(express.json());

// Status endpoint
expressApp.get('/status', (req, res) => {
    res.json({
        running: isMonitoring,
        url: mixcloudUrl
    });
});

// Set URL endpoint
expressApp.post('/setUrl', (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    mixcloudUrl = url;
    
    if (isMonitoring) {
        stopMonitoring()
            .then(() => startMonitoring(url))
            .then(() => res.json({ success: true }))
            .catch(error => res.status(500).json({ error: error.message }));
    } else {
        res.json({ success: true });
    }
});

// Start monitoring
expressApp.post('/start', (req, res) => {
    const { url, triggers } = req.body;
    
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }
    
    if (triggers) {
        triggerWords = triggers;
    }
    
    startMonitoring(url)
        .then(() => res.json({ success: true }))
        .catch(error => res.status(500).json({ error: error.message }));
});

// Stop monitoring
expressApp.post('/stop', (req, res) => {
    stopMonitoring()
        .then(() => res.json({ success: true }))
        .catch(error => res.status(500).json({ error: error.message }));
});

// Add a home page
expressApp.get('/', (req, res) => {
    res.send(`
    <html>
        <head>
            <title>Mixcloud Chat Trigger Server</title>
            <style>
                body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
                .status { padding: 10px; border-radius: 5px; margin: 20px 0; }
                .online { background-color: #d4edda; color: #155724; }
                .offline { background-color: #f8d7da; color: #721c24; }
            </style>
        </head>
        <body>
            <h1>Mixcloud Chat Trigger Server</h1>
            <div class="status ${isMonitoring ? 'online' : 'offline'}">
                Status: ${isMonitoring ? 'ONLINE - Monitoring ' + mixcloudUrl : 'OFFLINE - Not monitoring any stream'}
            </div>
            <p>This is the WebSocket server for the Mixcloud Chat Trigger application.</p>
            <p>WebSocket endpoint: ws://${req.headers.host}</p>
            <p>HTTP API endpoint: http://${req.headers.host}</p>
        </body>
    </html>
    `);
});

// Create HTTP server for Express
const httpServer = http.createServer(expressApp);

// Create WebSocket server
const initWebSocketServer = () => {
    wsServer = new WebSocket.Server({ server: httpServer });
    
    wsServer.on('connection', (ws) => {
        // Add client to list
        clients.push(ws);
        
        console.log('Client connected');
        
        // Send initial status
        ws.send(JSON.stringify({
            type: 'log',
            message: 'Connected to chat monitor server',
            logType: 'info'
        }));
        
        // Handle client disconnect
        ws.on('close', () => {
            // Remove client from list
            clients = clients.filter(client => client !== ws);
            console.log('Client disconnected');
        });
        
        // Handle messages from client
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.type === 'setTriggers') {
                    triggerWords = data.triggers;
                    ws.send(JSON.stringify({
                        type: 'log',
                        message: `Updated ${triggerWords.length} trigger words`,
                        logType: 'info'
                    }));
                }
            } catch (error) {
                console.error('Error processing message:', error);
            }
        });
    });
};

// Broadcast message to all clients
const broadcastMessage = (message) => {
    const messageString = JSON.stringify(message);
    
    clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(messageString);
        }
    });
};

// Log message and broadcast to clients
const log = (message, type = 'info') => {
    console.log(`[${type.toUpperCase()}] ${message}`);
    
    broadcastMessage({
        type: 'log',
        message,
        logType: type
    });
};

// Start monitoring Mixcloud chat
const startMonitoring = async (url) => {
    // Stop if already monitoring
    if (isMonitoring) {
        await stopMonitoring();
    }
    
    try {
        log(`Starting browser for: ${url}`);
        
        // Launch browser with cloud-friendly options
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process'
            ]
        });
        
        // Open page
        page = await browser.newPage();
        
        // Navigate to Mixcloud
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        log('Connected to Mixcloud stream');
        
        // Set monitoring state
        mixcloudUrl = url;
        isMonitoring = true;
        lastMessages = new Set();
        
        // Start interval to check for messages
        checkInterval = setInterval(checkForTriggers, 3000);
        
        return true;
    } catch (error) {
        log(`Error starting monitoring: ${error.message}`, 'error');
        throw error;
    }
};

// Stop monitoring
const stopMonitoring = async () => {
    // Clear interval
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
    
    // Close browser
    if (browser) {
        await browser.close();
        browser = null;
        page = null;
    }
    
    // Reset state
    isMonitoring = false;
    lastMessages = new Set();
    
    log('Monitoring stopped');
    
    return true;
};

// Check for trigger words in chat messages
const checkForTriggers = async () => {
    if (!isMonitoring || !page) {
        return;
    }
    
    try {
        // Check if chat container exists
        const hasChatContainer = await page.evaluate(() => {
            return document.querySelector('.chat-message') !== null;
        });
        
        if (!hasChatContainer) {
            log('Waiting for chat to load...');
            return;
        }
        
        // Get all chat messages
        const messages = await page.evaluate(() => {
            const messageElements = document.querySelectorAll('.chat-message');
            return Array.from(messageElements).map(el => {
                const username = el.querySelector('.chat-message-username')?.textContent || '';
                const text = el.querySelector('.chat-message-text')?.textContent || '';
                return { id: `${username}:${text}`, username, text };
            });
        });
        
        // Filter out messages we've already seen
        const newMessages = messages.filter(msg => !lastMessages.has(msg.id));
        
        // Update last messages set (keep only the last 100)
        lastMessages = new Set([
            ...Array.from(lastMessages).slice(-50),
            ...newMessages.map(msg => msg.id)
        ]);
        
        // Process new messages
        for (const message of newMessages) {
            // Skip empty messages
            if (!message.text) continue;
            
            // Check each trigger word
            for (const trigger of triggerWords) {
                if (message.text.toLowerCase().includes(trigger.word.toLowerCase())) {
                    log(`Trigger "${trigger.word}" detected in message from ${message.username}`);
                    
                    // Broadcast trigger to clients
                    broadcastMessage({
                        type: 'trigger',
                        trigger: trigger.word,
                        message: `${message.username}: ${message.text}`
                    });
                    
                    // Only trigger once per message
                    break;
                }
            }
        }
    } catch (error) {
        log(`Error checking for triggers: ${error.message}`, 'error');
    }
};

// Initialize and start server
const startServer = () => {
    // Initialize WebSocket server
    initWebSocketServer();
    
    // Start HTTP server
    const PORT = process.env.PORT || 8080;
    httpServer.listen(PORT, () => {
        console.log(`Server listening on port ${PORT}`);
        console.log(`WebSocket server running at ws://localhost:${PORT}`);
    });
};

// Handle clean shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await stopMonitoring();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down...');
    await stopMonitoring();
    process.exit(0);
});

// Start the server
startServer();
