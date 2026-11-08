const jwt = require('jsonwebtoken');
const pool = require('./db');

async function auth(req, res, next) {
    try {
        if (!process.env.JWT_SECRET) {
            console.error('JWT_SECRET is missing in .env');
            return res.status(500).json({
                message: 'Server authentication is not configured.'
            });
        }

        const header = req.headers.authorization || '';

        const token = header.startsWith('Bearer ')
            ? header.slice(7).trim()
            : req.cookies?.token;

        if (!token) {
            return res.status(401).json({
                message: 'Please sign in.'
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (!decoded.id || !decoded.role) {
            return res.status(401).json({
                message: 'Invalid session.'
            });
        }

        const [rows] = await pool.execute(
            `SELECT id, email, role, employee_id, is_active
             FROM users
             WHERE id = ?`,
            [decoded.id]
        );

        if (!rows.length || !rows[0].is_active) {
            return res.status(401).json({
                message: 'Account unavailable.'
            });
        }

        req.user = rows[0];

        return next();

    } catch (error) {
        if (error.name !== 'JsonWebTokenError' &&
            error.name !== 'TokenExpiredError') {
            console.error('Authentication error:', error);
        }

        return res.status(401).json({
            message: 'Invalid or expired session.'
        });
    }
}

const allow = (...roles) => (req, res, next) => {
    if (!req.user) {
        return res.status(401).json({
            message: 'Please sign in.'
        });
    }

    if (!roles.includes(req.user.role)) {
        return res.status(403).json({
            message: 'Permission denied.'
        });
    }

    return next();
};

module.exports = {
    auth,
    allow
};
