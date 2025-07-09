require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const express = require('express');

// Initialize bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Database setup
const db = new sqlite3.Database('crypto_bot.db', (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
    } else {
        console.log('Connected to SQLite database.');
    }
});

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        coin TEXT NOT NULL,
        condition TEXT NOT NULL,
        price REAL NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS favorites (
        chat_id TEXT NOT NULL,
        coin TEXT NOT NULL,
        PRIMARY KEY (chat_id, coin)
    )`);

    // Clean invalid alert rows
    db.run(`DELETE FROM alerts WHERE coin IS NULL OR condition IS NULL OR price IS NULL OR condition NOT IN ('>', '<', '=')`);
});

// Constants
const COINGECKO_API = 'https://api.coingecko.com/api/v3';
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_DELAY = 1200; // 1.2 seconds

// Cache and state management
const coinCache = new Map();
const userAlertState = new Map();

// Helper functions
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const formatNumber = (num) => {
    if (num >= 1e12) return `$${(num / 1e12).toFixed(1)}T`;
    if (num >= 1e9) return `$${(num / 1e9).toFixed(1)}B`;
    if (num >= 1e6) return `$${(num / 1e6).toFixed(1)}M`;
    return `$${num.toFixed(2)}`;
};

// API functions
const getCoinData = async (coinId) => {
    const cacheKey = `coin_${coinId}`;
    const cached = coinCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }

    let retries = 0;
    while (retries < 3) {
        try {
            await delay(RATE_LIMIT_DELAY);
            const response = await axios.get(`${COINGECKO_API}/coins/${coinId}`, {
                params: {
                    localization: false,
                    tickers: false,
                    community_data: false,
                    developer_data: false
                }
            });

            const data = response.data;
            coinCache.set(cacheKey, { data, timestamp: Date.now() });
            return data;
        } catch (error) {
            if (error.response?.status === 429) {
                retries++;
                await delay(Math.pow(2, retries) * 1000);
            } else if (error.response?.status === 404) {
                throw new Error('Coin not found');
            } else {
                throw error;
            }
        }
    }
    throw new Error('Rate limit exceeded');
};

const getTopCoins = async () => {
    const cacheKey = 'top_coins';
    const cached = coinCache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }

    try {
        await delay(RATE_LIMIT_DELAY);
        const response = await axios.get(`${COINGECKO_API}/coins/markets`, {
            params: {
                vs_currency: 'usd',
                order: 'market_cap_desc',
                per_page: 10,
                page: 1
            }
        });

        const data = response.data;
        coinCache.set(cacheKey, { data, timestamp: Date.now() });
        return data;
    } catch (error) {
        console.error('Error fetching top coins:', error.message);
        return [];
    }
};

// Bot commands
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    const welcomeMessage = `🚀 Welcome to Crypto Info Bot!

Available commands:
/coin <symbol> - Get detailed coin information
/alert - Set up price alerts interactively
/alert <coin> <condition> <price> - Quick alert setup
/alerts - View your active alerts
/addfav <coin> - Add coin to favorites
/favlist - View your favorite coins
/clearfavlist - Clear all favorite coins
/list - Show top 10 coins by market cap

Example: /coin bitcoin or /alert bitcoin > 30000`;

    bot.sendMessage(chatId, welcomeMessage);
});

bot.onText(/\/coin (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const coinSymbol = match[1].toLowerCase().trim();

    try {
        const coinData = await getCoinData(coinSymbol);
        
        const message = `🪙 **${coinData.name}** (${coinData.symbol.toUpperCase()})

💰 **Price:** ${formatNumber(coinData.market_data.current_price.usd)}
📊 **Market Cap:** ${formatNumber(coinData.market_data.market_cap.usd)}
📈 **24h High:** ${formatNumber(coinData.market_data.high_24h.usd)}
📉 **24h Low:** ${formatNumber(coinData.market_data.low_24h.usd)}
📊 **Volume:** ${formatNumber(coinData.market_data.total_volume.usd)}
🏆 **Rank:** #${coinData.market_cap_rank}

🔗 **Links:**
${coinData.links.homepage[0] ? `Website: ${coinData.links.homepage[0]}` : ''}
${coinData.links.blockchain_site[0] ? `Explorer: ${coinData.links.blockchain_site[0]}` : ''}
${coinData.links.whitepaper ? `Whitepaper: ${coinData.links.whitepaper}` : ''}`;

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error fetching coin data:', error.message);
        bot.sendMessage(chatId, '❌ Error: Could not fetch coin data. Please check the coin symbol and try again.');
    }
});

bot.onText(/\/alert$/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        // Get user's favorite coins
        const favorites = await new Promise((resolve, reject) => {
            db.all('SELECT coin FROM favorites WHERE chat_id = ?', [chatId], (err, rows) => {
                if (err) reject(err);
                else resolve(rows.map(row => row.coin));
            });
        });

        // Get top 10 coins
        const topCoins = await getTopCoins();
        
        // Combine and deduplicate
        const allCoins = [...new Set([...favorites, ...topCoins.map(coin => coin.id)])];
        
        if (allCoins.length === 0) {
            bot.sendMessage(chatId, '❌ No coins available. Please try again later.');
            return;
        }

        const keyboard = allCoins.slice(0, 20).map(coinId => [{
            text: coinId,
            callback_data: `select_coin_${coinId}`
        }]);

        bot.sendMessage(chatId, '🎯 Select a coin for price alert:', {
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (error) {
        console.error('Error setting up alert:', error.message);
        bot.sendMessage(chatId, '❌ Error setting up alert. Please try again.');
    }
});

bot.onText(/\/alert (.+) ([><]=?) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const coinSymbol = match[1].toLowerCase().trim();
    const condition = match[2];
    const price = parseFloat(match[3]);

    if (!['>', '<', '='].includes(condition)) {
        bot.sendMessage(chatId, '❌ Invalid condition. Use >, <, or =');
        return;
    }

    if (isNaN(price) || price <= 0) {
        bot.sendMessage(chatId, '❌ Invalid price. Please enter a valid number.');
        return;
    }

    try {
        // Verify coin exists
        await getCoinData(coinSymbol);
        
        db.run('INSERT INTO alerts (chat_id, coin, condition, price) VALUES (?, ?, ?, ?)',
            [chatId, coinSymbol, condition, price], (err) => {
                if (err) {
                    console.error('Error saving alert:', err.message);
                    bot.sendMessage(chatId, '❌ Error saving alert. Please try again.');
                } else {
                    bot.sendMessage(chatId, `✅ Alert set: ${coinSymbol} ${condition} $${price}`);
                }
            });
    } catch (error) {
        console.error('Error creating alert:', error.message);
        bot.sendMessage(chatId, '❌ Error: Could not find coin. Please check the symbol and try again.');
    }
});

bot.onText(/\/alerts/, (msg) => {
    const chatId = msg.chat.id;
    
    db.all('SELECT * FROM alerts WHERE chat_id = ?', [chatId], async (err, rows) => {
        if (err) {
            console.error('Error fetching alerts:', err.message);
            bot.sendMessage(chatId, '❌ Error fetching alerts.');
            return;
        }

        if (rows.length === 0) {
            bot.sendMessage(chatId, '📭 No active alerts found.');
            return;
        }

        let message = '🔔 **Your Active Alerts:**\n\n';
        
        for (const alert of rows) {
            try {
                const coinData = await getCoinData(alert.coin);
                message += `• ${coinData.name} (${coinData.symbol.toUpperCase()}) ${alert.condition} $${alert.price}\n`;
            } catch (error) {
                message += `• ${alert.coin} ${alert.condition} $${alert.price}\n`;
            }
        }

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });
});

bot.onText(/\/addfav (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const coinSymbol = match[1].toLowerCase().trim();

    try {
        // Verify coin exists
        await getCoinData(coinSymbol);
        
        db.run('INSERT OR IGNORE INTO favorites (chat_id, coin) VALUES (?, ?)',
            [chatId, coinSymbol], (err) => {
                if (err) {
                    console.error('Error adding favorite:', err.message);
                    bot.sendMessage(chatId, '❌ Error adding to favorites.');
                } else {
                    bot.sendMessage(chatId, `⭐ Added ${coinSymbol} to favorites!`);
                }
            });
    } catch (error) {
        console.error('Error adding favorite:', error.message);
        bot.sendMessage(chatId, '❌ Error: Could not find coin. Please check the symbol and try again.');
    }
});

bot.onText(/\/favlist/, (msg) => {
    const chatId = msg.chat.id;
    
    db.all('SELECT coin FROM favorites WHERE chat_id = ?', [chatId], async (err, rows) => {
        if (err) {
            console.error('Error fetching favorites:', err.message);
            bot.sendMessage(chatId, '❌ Error fetching favorites.');
            return;
        }

        if (rows.length === 0) {
            bot.sendMessage(chatId, '📝 No favorite coins found.');
            return;
        }

        let message = '⭐ **Your Favorite Coins:**\n\n';
        
        for (const fav of rows) {
            try {
                const coinData = await getCoinData(fav.coin);
                message += `• ${coinData.name} (${coinData.symbol.toUpperCase()})\n`;
            } catch (error) {
                message += `• ${fav.coin}\n`;
            }
        }

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    });
});

bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const topCoins = await getTopCoins();
        
        if (topCoins.length === 0) {
            bot.sendMessage(chatId, '❌ Could not fetch top coins. Please try again later.');
            return;
        }

        let message = '🏆 **Top 10 Coins by Market Cap:**\n\n';
        message += '```\n';
        message += '# │ Coin       │ Price     │ Market Cap\n';
        message += '──┼────────────┼───────────┼──────────────\n';
        
        topCoins.forEach((coin, index) => {
            const rank = `${index + 1}`.padStart(2, ' ');
            const name = coin.name.length > 10 ? coin.name.substring(0, 9) + '…' : coin.name.padEnd(10, ' ');
            const price = formatNumber(coin.current_price).padStart(9, ' ');
            const marketCap = formatNumber(coin.market_cap).padStart(12, ' ');
            
            message += `${rank}│ ${name} │ ${price} │ ${marketCap}\n`;
        });
        
        message += '```';

        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error fetching top coins:', error.message);
        bot.sendMessage(chatId, '❌ Error fetching top coins. Please try again later.');
    }
});

bot.onText(/\/clearfavlist/, (msg) => {
    const chatId = msg.chat.id;
    
    db.run('DELETE FROM favorites WHERE chat_id = ?', [chatId], function(err) {
        if (err) {
            console.error('Error clearing favorites:', err.message);
            bot.sendMessage(chatId, '❌ Error clearing favorites list.');
        } else {
            if (this.changes === 0) {
                bot.sendMessage(chatId, '📝 No favorites to clear.');
            } else {
                bot.sendMessage(chatId, `🗑️ Cleared ${this.changes} coin(s) from your favorites list.`);
            }
        }
    });
});

// Callback query handlers
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    try {
        if (data.startsWith('select_coin_')) {
            const coinId = data.replace('select_coin_', '');
            
            try {
                const coinData = await getCoinData(coinId);
                const currentPrice = formatNumber(coinData.market_data.current_price.usd);
                
                userAlertState.set(chatId, { coin: coinId, step: 'condition' });
                
                const keyboard = [
                    [{ text: '>', callback_data: `select_condition_>_${coinId}` }],
                    [{ text: '<', callback_data: `select_condition_<_${coinId}` }],
                    [{ text: '=', callback_data: `select_condition_=_${coinId}` }]
                ];

                bot.editMessageText(`🎯 Selected: **${coinData.name}** (${coinData.symbol.toUpperCase()})\n💰 Current Price: ${currentPrice}\n\nNow choose condition:`, {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    reply_markup: { inline_keyboard: keyboard },
                    parse_mode: 'Markdown'
                });
            } catch (error) {
                console.error('Error fetching coin data for alert:', error.message);
                bot.editMessageText(`🎯 Selected: ${coinId}\nNow choose condition:`, {
                    chat_id: chatId,
                    message_id: callbackQuery.message.message_id,
                    reply_markup: { inline_keyboard: keyboard }
                });
            }
        }
        else if (data.startsWith('select_condition_')) {
            const parts = data.split('_');
            const condition = parts[2];
            const coinId = parts[3];
            
            userAlertState.set(chatId, { coin: coinId, condition, step: 'price' });
            
            bot.editMessageText(`🎯 ${coinId} ${condition} ?\nPlease enter the target price:`, {
                chat_id: chatId,
                message_id: callbackQuery.message.message_id
            });
        }
        else if (data.startsWith('confirm_alert_')) {
            const parts = data.split('_');
            const coinId = parts[2];
            const condition = parts[3];
            const price = parseFloat(parts[4]);
            
            db.run('INSERT INTO alerts (chat_id, coin, condition, price) VALUES (?, ?, ?, ?)',
                [chatId, coinId, condition, price], (err) => {
                    if (err) {
                        console.error('Error saving alert:', err.message);
                        bot.sendMessage(chatId, '❌ Error saving alert.');
                    } else {
                        bot.sendMessage(chatId, `✅ Alert set: ${coinId} ${condition} $${price}`);
                    }
                });
            
            userAlertState.delete(chatId);
        }
        else if (data.startsWith('edit_alert_')) {
            const coinId = data.replace('edit_alert_', '');
            userAlertState.set(chatId, { coin: coinId, step: 'condition' });
            
            const keyboard = [
                [{ text: '>', callback_data: `select_condition_>_${coinId}` }],
                [{ text: '<', callback_data: `select_condition_<_${coinId}` }],
                [{ text: '=', callback_data: `select_condition_=_${coinId}` }]
            ];

            bot.sendMessage(chatId, `🎯 Editing alert for ${coinId}\nChoose condition:`, {
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        else if (data.startsWith('cancel_alert_')) {
            const chatId = data.replace('cancel_alert_', '');
            userAlertState.delete(parseInt(chatId));
            bot.sendMessage(chatId, '❌ Alert setup cancelled.');
        }
        
        bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Error handling callback:', error.message);
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Error processing request' });
    }
});

// Handle price input
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const alertState = userAlertState.get(chatId);
    
    if (alertState && alertState.step === 'price') {
        const price = parseFloat(msg.text);
        
        if (isNaN(price) || price <= 0) {
            bot.sendMessage(chatId, '❌ Invalid price. Please enter a valid number.');
            return;
        }
        
        const keyboard = [
            [{ text: '✅ Confirm', callback_data: `confirm_alert_${alertState.coin}_${alertState.condition}_${price}` }],
            [{ text: '✏️ Edit', callback_data: `edit_alert_${alertState.coin}` }],
            [{ text: '❌ Cancel', callback_data: `cancel_alert_${chatId}` }]
        ];
        
        bot.sendMessage(chatId, `🎯 Confirm alert:\n${alertState.coin} ${alertState.condition} $${price}`, {
            reply_markup: { inline_keyboard: keyboard }
        });
    }
});

// Cron job for checking alerts
cron.schedule('*/2 * * * *', async () => {
    console.log('Checking alerts...');
    
    db.all('SELECT * FROM alerts', [], async (err, rows) => {
        if (err) {
            console.error('Error fetching alerts:', err.message);
            return;
        }

        for (const alert of rows) {
            try {
                const coinData = await getCoinData(alert.coin);
                const currentPrice = coinData.market_data.current_price.usd;
                let triggered = false;

                switch (alert.condition) {
                    case '=':
                        triggered = Math.abs(currentPrice - alert.price) <= (alert.price * 0.01);
                        break;
                    case '>':
                        triggered = currentPrice > alert.price;
                        break;
                    case '<':
                        triggered = currentPrice < alert.price;
                        break;
                }

                if (triggered) {
                    const message = `🚨 **Price Alert Triggered!**\n\n${coinData.name} (${coinData.symbol.toUpperCase()}) is now ${formatNumber(currentPrice)}\nYour alert: ${alert.condition} $${alert.price}`;
                    
                    bot.sendMessage(alert.chat_id, message, { parse_mode: 'Markdown' });
                    
                    // Remove triggered alert
                    db.run('DELETE FROM alerts WHERE id = ?', [alert.id]);
                }
            } catch (error) {
                console.warn(`Error checking alert for ${alert.coin}:`, error.message);
            }
        }
    });
});

console.log('Bot is running...');

// Express app for health check and keeping service alive
const app = express();
const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get('/', (req, res) => {
    res.json({ 
        status: 'Crypto Bot is running!',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Ping endpoint for external monitoring
app.get('/ping', (req, res) => {
    res.json({ pong: true, time: Date.now() });
});

// Status endpoint
app.get('/status', (req, res) => {
    db.get('SELECT COUNT(*) as alertCount FROM alerts', [], (err, row) => {
        if (err) {
            res.status(500).json({ error: 'Database error' });
            return;
        }
        
        db.get('SELECT COUNT(*) as favCount FROM favorites', [], (err2, row2) => {
            if (err2) {
                res.status(500).json({ error: 'Database error' });
                return;
            }
            
            res.json({
                status: 'healthy',
                alerts: row.alertCount,
                favorites: row2.favCount,
                uptime: process.uptime(),
                timestamp: new Date().toISOString()
            });
        });
    });
});

// Start Express server
app.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
});

// Keep-alive mechanism - ping self every 14 minutes to prevent sleeping
if (process.env.NODE_ENV === 'production') {
    const RENDER_URL = process.env.RENDER_EXTERNAL_URL || `https://your-app-name.onrender.com`;
    
    setInterval(async () => {
        try {
            await axios.get(`${RENDER_URL}/ping`);
            console.log('Keep-alive ping sent');
        } catch (error) {
            console.error('Keep-alive ping failed:', error.message);
        }
    }, 14 * 60 * 1000); // 14 minutes
}

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err.message);
        } else {
            console.log('Database connection closed.');
        }
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT received, shutting down gracefully...');
    db.close((err) => {
        if (err) {
            console.error('Error closing database:', err.message);
        } else {
            console.log('Database connection closed.');
        }
        process.exit(0);
    });
});

// Error handling with better logging
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Don't exit process, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Don't exit process, just log the error
});