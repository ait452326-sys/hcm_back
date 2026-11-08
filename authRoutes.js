const router = require('express').Router();
const pool = require('./db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { auth, allow } = require('./auth');

// ==================== SETUP STATUS ====================

router.get('/setup-status', async (req, res) => {
    try {
        const [[result]] = await pool.query(
            'SELECT COUNT(*) AS n FROM users WHERE role = ?',
            ['admin']
        );

        res.json({ needsSetup: Number(result.n) === 0 });
    } catch (error) {
        console.error('Setup status error:', error);
        res.status(500).json({ message: 'Could not check setup status.' });
    }
});

// ==================== FIRST-TIME COMPANY SETUP ====================

router.post('/setup', async (req, res) => {
    const { companyName, adminName, email, password } = req.body || {};

    if (
        typeof companyName !== 'string' ||
        typeof adminName !== 'string' ||
        typeof email !== 'string' ||
        typeof password !== 'string' ||
        !companyName.trim() ||
        !adminName.trim() ||
        !email.trim() ||
        password.length < 8
    ) {
        return res.status(400).json({
            message: 'Complete all fields. Password must be at least 8 characters.'
        });
    }

    let connection;

    try {
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [[existingAdmin]] = await connection.query(
            'SELECT COUNT(*) AS n FROM users WHERE role = ?',
            ['admin']
        );

        if (Number(existingAdmin.n) > 0) {
            await connection.rollback();
            return res.status(409).json({
                message: 'Setup has already been completed.'
            });
        }

        const [company] = await connection.execute(
            'INSERT INTO company_settings (company_name) VALUES (?)',
            [companyName.trim()]
        );

        const passwordHash = await bcrypt.hash(password, 12);

        const [user] = await connection.execute(
            `INSERT INTO users (email, password_hash, role)
             VALUES (?, ?, 'admin')`,
            [email.toLowerCase().trim(), passwordHash]
        );

        await connection.execute(
            `INSERT INTO audit_logs
             (actor_user_id, action, entity, entity_id, after_json)
             VALUES (?, ?, ?, ?, ?)`,
            [
                user.insertId,
                'FIRST_RUN_SETUP',
                'company_settings',
                company.insertId,
                JSON.stringify({
                    companyName: companyName.trim(),
                    adminName: adminName.trim()
                })
            ]
        );

        await connection.commit();

        res.status(201).json({
            message: 'Company created. Sign in as Admin.'
        });

    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('Setup rollback error:', rollbackError);
            }
        }

        console.error('Setup error:', error);

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                message: 'This email is already registered.'
            });
        }

        res.status(500).json({
            message: 'Company setup failed.'
        });

    } finally {
        if (connection) connection.release();
    }
});

// ==================== CREATE HR ACCOUNT ====================

router.post('/create-hr', auth, allow('admin'), async (req, res) => {
    const { email, password } = req.body || {};

    if (
        typeof email !== 'string' ||
        typeof password !== 'string' ||
        !email.trim() ||
        password.length < 8
    ) {
        return res.status(400).json({
            message: 'Enter a valid email and a password of at least 8 characters.'
        });
    }

    let connection;

    try {
        const normalizedEmail = email.toLowerCase().trim();
        const passwordHash = await bcrypt.hash(password, 12);

        connection = await pool.getConnection();
        await connection.beginTransaction();

        const [existing] = await connection.execute(
            'SELECT id FROM users WHERE email = ?',
            [normalizedEmail]
        );

        if (existing.length > 0) {
            await connection.rollback();
            return res.status(409).json({
                message: 'An account with this email already exists.'
            });
        }

        const [result] = await connection.execute(
            `INSERT INTO users (email, password_hash, role)
             VALUES (?, ?, 'hr')`,
            [normalizedEmail, passwordHash]
        );

        await connection.execute(
            `INSERT INTO audit_logs
             (actor_user_id, action, entity, entity_id, after_json)
             VALUES (?, ?, ?, ?, ?)`,
            [
                req.user.id,
                'CREATE_HR_ACCOUNT',
                'users',
                result.insertId,
                JSON.stringify({
                    email: normalizedEmail,
                    role: 'hr'
                })
            ]
        );

        await connection.commit();

        res.status(201).json({
            message: 'HR account created successfully.',
            user: {
                id: result.insertId,
                email: normalizedEmail,
                role: 'hr'
            }
        });

    } catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error('HR rollback error:', rollbackError);
            }
        }

        console.error('HR account creation error:', error);

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                message: 'This email is already registered.'
            });
        }

        res.status(500).json({
            message: 'Could not create HR account.'
        });

    } finally {
        if (connection) connection.release();
    }
});

// ==================== LOGIN ====================

router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body || {};

        if (
            typeof email !== 'string' ||
            typeof password !== 'string' ||
            !email.trim() ||
            !password
        ) {
            return res.status(400).json({
                message: 'Email and password are required.'
            });
        }

        const [rows] = await pool.execute(
            'SELECT * FROM users WHERE email = ? AND is_active = 1',
            [email.toLowerCase().trim()]
        );

        if (
            !rows.length ||
            !await bcrypt.compare(password, rows[0].password_hash)
        ) {
            return res.status(401).json({
                message: 'Email or password is incorrect.'
            });
        }

        const user = rows[0];

        const token = jwt.sign(
            {
                id: user.id,
                role: user.role
            },
            process.env.JWT_SECRET,
            {
                expiresIn: process.env.JWT_EXPIRES_IN || '8h'
            }
        );

        res.json({
            token,
            user: {
                id: user.id,
                email: user.email,
                role: user.role,
                employeeId: user.employee_id
            }
        });

    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Login failed.' });
    }
});

// ==================== CURRENT USER ====================

router.get('/me', auth, (req, res) => {
    res.json({ user: req.user });
});

// ==================== CHANGE PASSWORD ====================

router.post('/change-password', auth, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body || {};

        if (
            typeof currentPassword !== 'string' ||
            typeof newPassword !== 'string' ||
            newPassword.length < 8
        ) {
            return res.status(400).json({
                message: 'New password must be at least 8 characters.'
            });
        }

        const [rows] = await pool.execute(
            'SELECT password_hash FROM users WHERE id = ?',
            [req.user.id]
        );

        if (
            !rows.length ||
            !await bcrypt.compare(currentPassword, rows[0].password_hash)
        ) {
            return res.status(400).json({
                message: 'Current password is incorrect.'
            });
        }

        const newHash = await bcrypt.hash(newPassword, 12);

        await pool.execute(
            'UPDATE users SET password_hash = ? WHERE id = ?',
            [newHash, req.user.id]
        );

        res.json({ message: 'Password changed successfully.' });

    } catch (error) {
        console.error('Password change error:', error);
        res.status(500).json({
            message: 'Could not change password.'
        });
    }
});

module.exports = router;
