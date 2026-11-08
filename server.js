require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const pool = require('./db');

const app = express();

// ==================== SECURITY ====================

app.use(helmet({
    contentSecurityPolicy: false
}));

app.use(express.json({
    limit: '1mb'
}));

// Rate limit API requests
app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: {
        message: 'Too many requests. Please try again later.'
    }
}));

// ==================== API ROUTES ====================

app.use('/api/auth', require('./authRoutes'));
app.use('/api', require('./core'));

// API 404 response
app.use('/api', (req, res) => {
    res.status(404).json({
        message: 'API endpoint not found.'
    });
});

// ==================== FRONTEND FILES ====================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'style.css'));
});

app.get('/app.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'app.js'));
});

// Frontend fallback
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ==================== ERROR HANDLER ====================

app.use((error, req, res, next) => {
    console.error('Server error:', error);

    res.status(500).json({
        message: 'Internal server error.'
    });
});

// ==================== START SERVER ====================

const port = process.env.PORT || 3000;

if (!process.env.JWT_SECRET) {
    console.error('JWT_SECRET is missing from .env file.');
    process.exit(1);
}

pool.query('SELECT 1')
    .then(() => {
        console.log('MySQL database connected successfully!');

        app.listen(port, () => {
            console.log(`HCM Lite running at http://localhost:${port}`);
        });
    })
    .catch(error => {
        console.error('Database connection failed:', error.message);
        process.exit(1);
    });
