const router = require('express').Router();
const pool = require('./db');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { auth, allow } = require('./auth');
const audit = require('./audit');

router.use(auth);

// ==================== HELPERS ====================

function getDateString(date) {
    return new Date(date).toISOString().slice(0, 10);
}

async function calculateWorkingDays(startDate, endDate) {
    const [settings] = await pool.query(
        'SELECT weekend_days FROM company_settings ORDER BY id DESC LIMIT 1'
    );

    let weekendDays = [0, 6];

    if (settings.length && settings[0].weekend_days) {
        try {
            weekendDays = typeof settings[0].weekend_days === 'string'
                ? JSON.parse(settings[0].weekend_days)
                : settings[0].weekend_days;
        } catch {
            weekendDays = [0, 6];
        }
    }

    const [holidays] = await pool.execute(
        'SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ?',
        [startDate, endDate]
    );

    const holidaySet = new Set(
        holidays.map(h => getDateString(h.holiday_date))
    );

    const start = new Date(startDate + 'T00:00:00Z');
    const end = new Date(endDate + 'T00:00:00Z');

    let total = 0;

    for (
        let date = new Date(start);
        date <= end;
        date.setUTCDate(date.getUTCDate() + 1)
    ) {
        const day = date.getUTCDay();
        const formatted = date.toISOString().slice(0, 10);

        if (!weekendDays.includes(day) && !holidaySet.has(formatted)) {
            total++;
        }
    }

    return total;
}

// ==================== PROFILE ====================

router.get('/me', async (req, res) => {
    try {
        if (req.user.role !== 'employee') {
            return res.json({ user: req.user });
        }

        const [rows] = await pool.execute(
            `SELECT e.*, d.name department_name,
            ds.name designation_name
            FROM employees e
            LEFT JOIN departments d ON d.id = e.department_id
            LEFT JOIN designations ds ON ds.id = e.designation_id
            WHERE e.id = ?`,
            [req.user.employee_id]
        );

        res.json({
            user: req.user,
            employee: rows[0] || null
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ message: 'Could not load profile.' });
    }
});

// ==================== DEPARTMENTS ====================

router.get('/departments', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM departments ORDER BY name'
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Could not load departments.' });
    }
});

router.post('/departments', allow('admin'), async (req, res) => {
    const name = String(req.body.name || '').trim();

    if (!name) {
        return res.status(400).json({ message: 'Department name required.' });
    }

    try {
        const [result] = await pool.execute(
            'INSERT INTO departments(name) VALUES(?)',
            [name]
        );

        await audit(
            req.user.id, 'CREATE', 'department',
            result.insertId, null, { name }
        );

        res.status(201).json({ id: result.insertId, name });
    } catch (error) {
        res.status(400).json({
            message: 'Department already exists or invalid.'
        });
    }
});

// ==================== DESIGNATIONS ====================

router.get('/designations', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM designations ORDER BY name'
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Could not load designations.' });
    }
});

router.post('/designations', allow('admin'), async (req, res) => {
    const name = String(req.body.name || '').trim();

    if (!name) {
        return res.status(400).json({ message: 'Designation name required.' });
    }

    try {
        const [result] = await pool.execute(
            'INSERT INTO designations(name) VALUES(?)',
            [name]
        );

        await audit(
            req.user.id, 'CREATE', 'designation',
            result.insertId, null, { name }
        );

        res.status(201).json({ id: result.insertId, name });
    } catch (error) {
        res.status(400).json({
            message: 'Could not create designation.'
        });
    }
});

// ==================== EMPLOYEES ====================

// Employee list
router.get('/employees', allow('admin', 'hr'), async (req, res) => {
    try {
        const q = '%' + String(req.query.q || '').trim() + '%';
        const dept = req.query.department || null;

        const [rows] = await pool.execute(
            `SELECT e.id, e.employee_code, e.full_name, e.email,
            e.phone, e.address, e.gender, e.join_date, e.status,
            e.basic_salary, e.department_id, e.designation_id,
            d.name department, ds.name designation
            FROM employees e
            LEFT JOIN departments d ON d.id = e.department_id
            LEFT JOIN designations ds ON ds.id = e.designation_id
            WHERE (
                e.full_name LIKE ?
                OR e.email LIKE ?
                OR e.employee_code LIKE ?
            )
            AND (? IS NULL OR e.department_id = ?)
            ORDER BY e.id DESC
            LIMIT 300`,
            [q, q, q, dept, dept]
        );

        res.json(rows);
    } catch (error) {
        console.error('Employees error:', error);
        res.status(500).json({ message: 'Could not load employees.' });
    }
});

// Add employee
router.post('/employees', allow('admin', 'hr'), async (req, res) => {
    const b = req.body;

    if (
        !b.full_name ||
        !b.email ||
        !b.employee_code ||
        b.basic_salary === undefined ||
        b.basic_salary === '' ||
        !Number.isFinite(Number(b.basic_salary)) ||
        Number(b.basic_salary) <= 0
    ) {
        return res.status(400).json({
            message: 'Name, email, employee code and positive salary are required.'
        });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const email = String(b.email).trim().toLowerCase();

        const [employee] = await connection.execute(
            `INSERT INTO employees
            (employee_code, full_name, email, phone, address,
            gender, department_id, designation_id, join_date, basic_salary)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                String(b.employee_code).trim(),
                String(b.full_name).trim(),
                email,
                b.phone || null,
                b.address || null,
                b.gender || null,
                b.department_id || null,
                b.designation_id || null,
                b.join_date || new Date().toISOString().slice(0, 10),
                Number(b.basic_salary)
            ]
        );

        const temporaryPassword =
            b.temporary_password ||
            ('ChangeMe' + crypto.randomBytes(5).toString('hex') + '!');

        const [user] = await connection.execute(
            `INSERT INTO users
            (email, password_hash, role, employee_id, must_change_password)
            VALUES (?, ?, 'employee', ?, 1)`,
            [
                email,
                await bcrypt.hash(temporaryPassword, 12),
                employee.insertId
            ]
        );

        await audit(
            req.user.id,
            'CREATE',
            'employee',
            employee.insertId,
            null,
            { full_name: b.full_name, email },
            connection
        );

        await connection.commit();

        res.status(201).json({
            employeeId: employee.insertId,
            loginEmail: email,
            temporaryPassword,
            userId: user.insertId
        });
    } catch (error) {
        await connection.rollback();
        console.error('Employee creation error:', error);

        res.status(400).json({
            message: 'Could not create employee. Check email, employee code and department.'
        });
    } finally {
        connection.release();
    }
});

// Edit employee
router.put('/employees/:id', allow('admin', 'hr'), async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body;

    if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ message: 'Invalid employee ID.' });
    }

    if (!b.full_name || !b.email || !b.employee_code ||
        !Number.isFinite(Number(b.basic_salary)) ||
        Number(b.basic_salary) <= 0) {
        return res.status(400).json({
            message: 'Name, email, employee code and valid salary are required.'
        });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [existing] = await connection.execute(
            'SELECT * FROM employees WHERE id = ? FOR UPDATE',
            [id]
        );

        if (!existing.length) {
            await connection.rollback();
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const email = String(b.email).trim().toLowerCase();

        await connection.execute(
            `UPDATE employees SET
            employee_code = ?, full_name = ?, email = ?,
            phone = ?, address = ?, gender = ?,
            department_id = ?, designation_id = ?,
            join_date = ?, basic_salary = ?
            WHERE id = ?`,
            [
                String(b.employee_code).trim(),
                String(b.full_name).trim(),
                email,
                b.phone || null,
                b.address || null,
                b.gender || null,
                b.department_id || null,
                b.designation_id || null,
                b.join_date,
                Number(b.basic_salary),
                id
            ]
        );

        await connection.execute(
            'UPDATE users SET email = ? WHERE employee_id = ? AND role = ?',
            [email, id, 'employee']
        );

        await audit(
            req.user.id,
            'UPDATE',
            'employee',
            id,
            { full_name: existing[0].full_name },
            { full_name: b.full_name },
            connection
        );

        await connection.commit();

        res.json({ message: 'Employee updated successfully.' });
    } catch (error) {
        await connection.rollback();
        console.error('Employee update error:', error);
        res.status(400).json({
            message: 'Could not update employee. Check email and employee code.'
        });
    } finally {
        connection.release();
    }
});

// Suspend, reactivate or terminate employee
router.patch('/employees/:id/status', allow('admin', 'hr'), async (req, res) => {
    const employeeId = Number(req.params.id);
    const status = String(req.body.status || '').trim().toLowerCase();

    if (!Number.isInteger(employeeId) || employeeId <= 0) {
        return res.status(400).json({ message: 'Invalid employee ID.' });
    }

    if (!['active', 'probation', 'inactive', 'exited'].includes(status)) {
        return res.status(400).json({
            message: 'Invalid employee status.'
        });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            'SELECT id, full_name, status FROM employees WHERE id = ? FOR UPDATE',
            [employeeId]
        );

        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({ message: 'Employee not found.' });
        }

        const employee = rows[0];

        if (employee.status === 'exited' && status !== 'exited') {
            await connection.rollback();
            return res.status(400).json({
                message: 'Terminated employee cannot be reactivated.'
            });
        }

        if (employee.status === status) {
            await connection.rollback();
            return res.status(409).json({
                message: 'Employee already has this status.'
            });
        }

        await connection.execute(
            'UPDATE employees SET status = ?, exit_date = ? WHERE id = ?',
            [
                status,
                status === 'exited' ? new Date().toISOString().slice(0, 10) : null,
                employeeId
            ]
        );

        await connection.execute(
            'UPDATE users SET is_active = ? WHERE employee_id = ? AND role = ?',
            [
                ['active', 'probation'].includes(status) ? 1 : 0,
                employeeId,
                'employee'
            ]
        );

        await audit(
            req.user.id,
            status === 'inactive' ? 'SUSPEND' :
                status === 'exited' ? 'TERMINATE' : 'REACTIVATE',
            'employee',
            employeeId,
            { status: employee.status },
            { status },
            connection
        );

        await connection.commit();

        res.json({
            message: 'Employee status updated successfully.',
            employeeId,
            status
        });
    } catch (error) {
        await connection.rollback();
        console.error('Employee status error:', error);
        res.status(500).json({
            message: 'Could not update employee status.'
        });
    } finally {
        connection.release();
    }
});

// ==================== ATTENDANCE ====================

// Admin/HR: Today's attendance
router.get('/attendance/today', allow('admin', 'hr'), async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT e.id employee_id, e.employee_code,
            e.full_name, a.check_in, a.check_out, a.status
            FROM employees e
            LEFT JOIN attendance a
            ON a.employee_id = e.id AND a.work_date = CURDATE()
            WHERE e.status IN ('active', 'probation')
            ORDER BY e.full_name`
        );

        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Could not load attendance.' });
    }
});

// Employee: Check in
router.post('/attendance/check-in', allow('employee'), async (req, res) => {
    try {
        const id = req.user.employee_id;

        if (!id) {
            return res.status(400).json({ message: 'Employee profile missing.' });
        }

        const [settings] = await pool.query(
            'SELECT office_start, grace_minutes FROM company_settings ORDER BY id DESC LIMIT 1'
        );

        const config = settings[0] || {
            office_start: '09:00:00',
            grace_minutes: 15
        };

        const [existing] = await pool.execute(
            'SELECT id FROM attendance WHERE employee_id = ? AND work_date = CURDATE()',
            [id]
        );

        if (existing.length) {
            return res.status(409).json({
                message: 'You already checked in today.'
            });
        }

        const now = new Date();
        const [hours, minutes] = String(config.office_start)
            .split(':').map(Number);

        const cutoff = new Date();
        cutoff.setHours(
            hours,
            minutes + Number(config.grace_minutes),
            0,
            0
        );

        const status = now > cutoff ? 'late' : 'present';

        const [result] = await pool.execute(
            `INSERT INTO attendance
            (employee_id, work_date, check_in, status, source)
            VALUES (?, CURDATE(), NOW(), ?, 'web')`,
            [id, status]
        );

        await audit(
            req.user.id, 'CHECK_IN', 'attendance',
            result.insertId, null, { status }
        );

        res.status(201).json({ message: 'Checked in.', status });
    } catch (error) {
        console.error('Check-in error:', error);
        res.status(500).json({ message: 'Could not check in.' });
    }
});

// Employee: Check out
router.post('/attendance/check-out', allow('employee'), async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, check_in, check_out
            FROM attendance
            WHERE employee_id = ? AND work_date = CURDATE()`,
            [req.user.employee_id]
        );

        if (!rows.length) {
            return res.status(400).json({ message: 'Check in first.' });
        }

        if (rows[0].check_out) {
            return res.status(409).json({ message: 'Already checked out.' });
        }

        await pool.execute(
            `UPDATE attendance
            SET check_out = NOW(),
            status = IF(
                TIMESTAMPDIFF(MINUTE, check_in, NOW()) < 300,
                'half_day',
                status
            )
            WHERE id = ?`,
            [rows[0].id]
        );

        res.json({ message: 'Checked out.' });
    } catch (error) {
        console.error('Check-out error:', error);
        res.status(500).json({ message: 'Could not check out.' });
    }
});

// Employee: Own attendance
router.get('/attendance/mine', allow('employee'), async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT * FROM attendance
            WHERE employee_id = ?
            ORDER BY work_date DESC LIMIT 120`,
            [req.user.employee_id]
        );

        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Could not load your attendance.' });
    }
});

// ==================== LEAVE MANAGEMENT ====================

// Employee: Apply for leave
router.post('/leaves', allow('employee'), async (req, res) => {
    const { leave_type_id, start_date, end_date, reason } = req.body;

    if (!leave_type_id || !start_date || !end_date) {
        return res.status(400).json({
            message: 'Leave type, start date and end date are required.'
        });
    }

    if (end_date < start_date) {
        return res.status(400).json({
            message: 'End date cannot be before start date.'
        });
    }

    try {
        const working_days = await calculateWorkingDays(start_date, end_date);

        if (working_days <= 0) {
            return res.status(400).json({
                message: 'Selected dates contain no working days.'
            });
        }

        const [type] = await pool.execute(
            'SELECT id FROM leave_types WHERE id = ?',
            [leave_type_id]
        );

        if (!type.length) {
            return res.status(400).json({ message: 'Invalid leave type.' });
        }

        const [result] = await pool.execute(
            `INSERT INTO leave_requests
            (employee_id, leave_type_id, start_date, end_date,
            working_days, reason, status)
            VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
            [
                req.user.employee_id,
                leave_type_id,
                start_date,
                end_date,
                working_days,
                reason || null
            ]
        );

        await audit(
            req.user.id, 'CREATE', 'leave',
            result.insertId, null,
            { start_date, end_date, working_days, status: 'pending' }
        );

        res.status(201).json({
            message: 'Leave application submitted.',
            leaveId: result.insertId,
            working_days
        });
    } catch (error) {
        console.error('Leave application error:', error);
        res.status(400).json({
            message: 'Could not submit leave application.'
        });
    }
});

// Employee: Own leave requests
router.get('/leaves/mine', allow('employee'), async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT l.*, lt.name leave_type
            FROM leave_requests l
            LEFT JOIN leave_types lt ON lt.id = l.leave_type_id
            WHERE l.employee_id = ?
            ORDER BY l.id DESC`,
            [req.user.employee_id]
        );

        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Could not load leave requests.' });
    }
});

// Admin/HR: Pending leave requests
router.get('/leaves/pending', allow('admin', 'hr'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT l.*, e.full_name, e.employee_code,
            lt.name leave_type
            FROM leave_requests l
            JOIN employees e ON e.id = l.employee_id
            LEFT JOIN leave_types lt ON lt.id = l.leave_type_id
            WHERE l.status = 'pending'
            ORDER BY l.id ASC`
        );

        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Could not load pending leaves.' });
    }
});

// Admin/HR: Approve or reject leave
router.patch('/leaves/:id/decision', allow('admin', 'hr'), async (req, res) => {
    const leaveId = Number(req.params.id);
    const decision = String(req.body.status || '').toLowerCase();
    const comment = req.body.decision_comment || null;

    if (!Number.isInteger(leaveId) || leaveId <= 0) {
        return res.status(400).json({ message: 'Invalid leave ID.' });
    }

    if (!['approved', 'rejected'].includes(decision)) {
        return res.status(400).json({
            message: 'Status must be approved or rejected.'
        });
    }

    try {
        const [rows] = await pool.execute(
            'SELECT id, status FROM leave_requests WHERE id = ?',
            [leaveId]
        );

        if (!rows.length) {
            return res.status(404).json({ message: 'Leave not found.' });
        }

        if (rows[0].status !== 'pending') {
            return res.status(409).json({
                message: 'This leave has already been processed.'
            });
        }

        await pool.execute(
            `UPDATE leave_requests
            SET status = ?, decision_comment = ?,
            decided_by = ?, decided_at = NOW()
            WHERE id = ?`,
            [decision, comment, req.user.id, leaveId]
        );

        await audit(
            req.user.id,
            decision.toUpperCase(),
            'leave',
            leaveId,
            { status: 'pending' },
            { status: decision, decision_comment: comment }
        );

        res.json({
            message: `Leave ${decision}.`,
            leaveId,
            status: decision
        });
    } catch (error) {
        console.error('Leave decision error:', error);
        res.status(500).json({
            message: 'Could not update leave decision.'
        });
    }
});

// Leave types
router.get('/leave-types', async (req, res) => {
    try {
        const [rows] = await pool.query(
            'SELECT * FROM leave_types ORDER BY name'
        );
        res.json(rows);
    } catch (error) {
        res.status(500).json({ message: 'Could not load leave types.' });
    }
});

// ==================== PAYROLL ====================

// Admin/HR: Payroll records
router.get('/payroll', allow('admin', 'hr'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT p.id, p.id payslip_id, p.payroll_run_id,
            p.employee_id, p.basic_salary, p.hra, p.medical,
            p.gross_salary, p.deductions, p.tax, p.net_salary,
            r.month, r.year, r.status, r.created_at,
            e.full_name, e.employee_code
            FROM payslips p
            JOIN payroll_runs r ON r.id = p.payroll_run_id
            JOIN employees e ON e.id = p.employee_id
            ORDER BY r.year DESC, r.month DESC, e.full_name
            LIMIT 300`
        );

        res.json(rows);
    } catch (error) {
        console.error('Payroll list error:', error);
        res.status(500).json({ message: 'Could not load payroll.' });
    }
});

// Admin/HR: Generate payroll for a month
router.post('/payroll/run', allow('admin', 'hr'), async (req, res) => {
    const month = Number(req.body.month);
    const year = Number(req.body.year);

    if (
        !Number.isInteger(month) || month < 1 || month > 12 ||
        !Number.isInteger(year) || year < 2000 || year > 2200
    ) {
        return res.status(400).json({
            message: 'Valid month and year are required.'
        });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [existingRun] = await connection.execute(
            'SELECT id FROM payroll_runs WHERE month = ? AND year = ? FOR UPDATE',
            [month, year]
        );

        if (existingRun.length) {
            await connection.rollback();
            return res.status(409).json({
                message: 'Payroll already exists for this month.'
            });
        }

        const [employees] = await connection.query(
            `SELECT id, basic_salary
            FROM employees
            WHERE status IN ('active', 'probation')`
        );

        if (!employees.length) {
            await connection.rollback();
            return res.status(400).json({
                message: 'No active employees found.'
            });
        }

        const [run] = await connection.execute(
            `INSERT INTO payroll_runs
            (month, year, status, created_by)
            VALUES (?, ?, 'draft', ?)`,
            [month, year, req.user.id]
        );

        let created = 0;

        for (const employee of employees) {
            const [attendance] = await connection.execute(
                `SELECT
                SUM(status IN ('present', 'late')) present_days,
                SUM(status = 'half_day') half_days
                FROM attendance
                WHERE employee_id = ?
                AND MONTH(work_date) = ?
                AND YEAR(work_date) = ?`,
                [employee.id, month, year]
            );

            const present = Number(attendance[0].present_days || 0);
            const half = Number(attendance[0].half_days || 0);
            const payableDays = present + (half * 0.5);

            const basic = Number(employee.basic_salary);
            const perDay = basic / 30;
            const deductions = Math.max(0, (30 - payableDays) * perDay);
            const gross = basic;
            const tax = 0;
            const net = Math.max(0, gross - deductions - tax);

            await connection.execute(
                `INSERT INTO payslips
                (payroll_run_id, employee_id, basic_salary,
                hra, medical, gross_salary, deductions, tax, net_salary)
                VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)`,
                [
                    run.insertId,
                    employee.id,
                    basic,
                    gross,
                    deductions,
                    tax,
                    net
                ]
            );

            created++;
        }

        await audit(
            req.user.id,
            'RUN_PAYROLL',
            'payroll_run',
            run.insertId,
            null,
            { month, year, created },
            connection
        );

        await connection.commit();

        res.json({
            message: 'Payroll generated.',
            payrollRunId: run.insertId,
            created,
            skipped: 0
        });
    } catch (error) {
        await connection.rollback();
        console.error('Payroll run error:', error);
        res.status(500).json({
            message: 'Could not generate payroll.'
        });
    } finally {
        connection.release();
    }
});

// Admin only: Finalize payroll using a payslip ID
router.patch('/payroll/:id/finalize', allow('admin'), async (req, res) => {
    const payslipId = Number(req.params.id);

    if (!Number.isInteger(payslipId) || payslipId <= 0) {
        return res.status(400).json({ message: 'Invalid payroll ID.' });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        const [rows] = await connection.execute(
            `SELECT r.id, r.status
            FROM payslips p
            JOIN payroll_runs r ON r.id = p.payroll_run_id
            WHERE p.id = ?
            FOR UPDATE`,
            [payslipId]
        );

        if (!rows.length) {
            await connection.rollback();
            return res.status(404).json({
                message: 'Payroll record not found.'
            });
        }

        if (rows[0].status !== 'draft') {
            await connection.rollback();
            return res.status(409).json({
                message: 'This payroll is already finalized.'
            });
        }

        const runId = rows[0].id;

        await connection.execute(
            `UPDATE payroll_runs
            SET status = 'finalized',
            finalized_by = ?, finalized_at = NOW()
            WHERE id = ?`,
            [req.user.id, runId]
        );

        await audit(
            req.user.id,
            'FINALIZE',
            'payroll_run',
            runId,
            { status: 'draft' },
            { status: 'finalized' },
            connection
        );

        await connection.commit();

        res.json({ message: 'Payroll finalized.' });
    } catch (error) {
        await connection.rollback();
        console.error('Payroll finalize error:', error);
        res.status(500).json({
            message: 'Could not finalize payroll.'
        });
    } finally {
        connection.release();
    }
});

// ==================== PAYSLIPS ====================

// Employee/Admin/HR: Payslip list
router.get('/payslips', async (req, res) => {
    try {
        let rows;

        if (req.user.role === 'employee') {
            [rows] = await pool.execute(
                `SELECT p.*, r.month, r.year, r.status payroll_status,
                e.full_name, e.employee_code
                FROM payslips p
                JOIN payroll_runs r ON r.id = p.payroll_run_id
                JOIN employees e ON e.id = p.employee_id
                WHERE p.employee_id = ?
                AND r.status = 'finalized'
                ORDER BY r.year DESC, r.month DESC`,
                [req.user.employee_id]
            );
        } else {
            [rows] = await pool.query(
                `SELECT p.*, r.month, r.year, r.status payroll_status,
                e.full_name, e.employee_code
                FROM payslips p
                JOIN payroll_runs r ON r.id = p.payroll_run_id
                JOIN employees e ON e.id = p.employee_id
                ORDER BY r.year DESC, r.month DESC
                LIMIT 300`
            );
        }

        res.json(rows);
    } catch (error) {
        console.error('Payslips error:', error);
        res.status(500).json({ message: 'Could not load payslips.' });
    }
});

// View one payslip
router.get('/payslips/:id', async (req, res) => {
    const payslipId = Number(req.params.id);

    if (!Number.isInteger(payslipId) || payslipId <= 0) {
        return res.status(400).json({ message: 'Invalid payslip ID.' });
    }

    try {
        let rows;

        if (req.user.role === 'employee') {
            [rows] = await pool.execute(
                `SELECT p.*, r.month, r.year, r.status payroll_status,
                e.full_name, e.employee_code,
                e.department_id, e.designation_id
                FROM payslips p
                JOIN payroll_runs r ON r.id = p.payroll_run_id
                JOIN employees e ON e.id = p.employee_id
                WHERE p.id = ? AND p.employee_id = ?
                AND r.status = 'finalized'`,
                [payslipId, req.user.employee_id]
            );
        } else {
            [rows] = await pool.execute(
                `SELECT p.*, r.month, r.year, r.status payroll_status,
                e.full_name, e.employee_code,
                e.department_id, e.designation_id
                FROM payslips p
                JOIN payroll_runs r ON r.id = p.payroll_run_id
                JOIN employees e ON e.id = p.employee_id
                WHERE p.id = ?`,
                [payslipId]
            );
        }

        if (!rows.length) {
            return res.status(404).json({ message: 'Payslip not found.' });
        }

        res.json(rows[0]);
    } catch (error) {
        console.error('Payslip detail error:', error);
        res.status(500).json({ message: 'Could not load payslip.' });
    }
});

// ==================== ANNOUNCEMENTS ====================

router.get('/announcements', async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT a.*, u.email author, u.email created_by_name
            FROM announcements a
            LEFT JOIN users u ON u.id = a.created_by
            ORDER BY a.id DESC
            LIMIT 100`
        );

        res.json(rows);
    } catch (error) {
        console.error('Announcements error:', error);
        res.status(500).json({
            message: 'Could not load announcements.'
        });
    }
});

router.post('/announcements', allow('admin', 'hr'), async (req, res) => {
    const title = String(req.body.title || '').trim();
    const message = String(req.body.message || '').trim();

    if (!title || !message) {
        return res.status(400).json({
            message: 'Title and message are required.'
        });
    }

    try {
        const [result] = await pool.execute(
            `INSERT INTO announcements
            (title, message, created_by)
            VALUES (?, ?, ?)`,
            [title, message, req.user.id]
        );

        await audit(
            req.user.id,
            'CREATE',
            'announcement',
            result.insertId,
            null,
            { title, message }
        );

        res.status(201).json({
            message: 'Announcement published.',
            id: result.insertId
        });
    } catch (error) {
        console.error('Announcement creation error:', error);
        res.status(500).json({
            message: 'Could not publish announcement.'
        });
    }
});

// ==================== NOTIFICATIONS ====================

router.get('/notifications', async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT * FROM notifications
            WHERE user_id = ?
            ORDER BY id DESC LIMIT 100`,
            [req.user.id]
        );

        res.json(rows);
    } catch (error) {
        res.status(500).json({
            message: 'Could not load notifications.'
        });
    }
});

// ==================== AUDIT LOGS ====================

router.get('/audit-logs', allow('admin'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT a.*, u.email actor_email
            FROM audit_logs a
            LEFT JOIN users u ON u.id = a.actor_user_id
            ORDER BY a.id DESC
            LIMIT 300`
        );

        res.json(rows);
    } catch (error) {
        console.error('Audit logs error:', error);
        res.status(500).json({
            message: 'Could not load audit logs.'
        });
    }
});

// ==================== DASHBOARD ====================

router.get('/dashboard', async (req, res) => {
    try {
        // Employee dashboard
        if (req.user.role === 'employee') {
            const employeeId = req.user.employee_id;

            const [[employee]] = await pool.execute(
                `SELECT e.id, e.full_name, e.employee_code,
                e.status, e.basic_salary,
                d.name department,
                ds.name designation
                FROM employees e
                LEFT JOIN departments d ON d.id = e.department_id
                LEFT JOIN designations ds ON ds.id = e.designation_id
                WHERE e.id = ?`,
                [employeeId]
            );

            const [[today]] = await pool.execute(
                `SELECT check_in, check_out, status
                FROM attendance
                WHERE employee_id = ? AND work_date = CURDATE()`,
                [employeeId]
            );

            const [[attendance]] = await pool.execute(
                `SELECT COUNT(*) total_days,
                SUM(status = 'present') present_days,
                SUM(status = 'late') late_days
                FROM attendance
                WHERE employee_id = ?
                AND MONTH(work_date) = MONTH(CURDATE())
                AND YEAR(work_date) = YEAR(CURDATE())`,
                [employeeId]
            );

            const [[leaveCount]] = await pool.execute(
                `SELECT COUNT(*) total_leaves
                FROM leave_requests
                WHERE employee_id = ?`,
                [employeeId]
            );

            const [leaveBalances] = await pool.execute(
                `SELECT lt.id, lt.name leave_type,
                lt.annual_quota,
                GREATEST(
                    0,
                    lt.annual_quota - COALESCE(SUM(
                        CASE WHEN l.status = 'approved'
                        AND YEAR(l.start_date) = YEAR(CURDATE())
                        THEN l.working_days ELSE 0 END
                    ), 0)
                ) remaining
                FROM leave_types lt
                LEFT JOIN leave_requests l
                ON l.leave_type_id = lt.id
                AND l.employee_id = ?
                GROUP BY lt.id, lt.name, lt.annual_quota
                ORDER BY lt.name`,
                [employeeId]
            );

            return res.json({
                role: 'employee',
                employee,
                today: today || null,
                attendance,
                lateCount: Number(attendance.late_days || 0),
                leaves: leaveCount,
                leaveBalances
            });
        }

        // Admin and HR dashboard
        const [[employeeStats]] = await pool.query(
            `SELECT COUNT(*) total,
            SUM(status IN ('active', 'probation')) active,
            SUM(status = 'inactive') inactive,
            SUM(status = 'exited') exited
            FROM employees`
        );

        const [[attendanceStats]] = await pool.query(
            `SELECT COUNT(*) total,
            SUM(status = 'present') present,
            SUM(status = 'late') late,
            SUM(status = 'half_day') half_day
            FROM attendance
            WHERE work_date = CURDATE()`
        );

        const [[leaveStats]] = await pool.query(
            `SELECT COUNT(*) pending
            FROM leave_requests
            WHERE status = 'pending'`
        );

        const [departments] = await pool.query(
            `SELECT d.id, d.name,
            COUNT(e.id) employee_count
            FROM departments d
            LEFT JOIN employees e ON e.department_id = d.id
            GROUP BY d.id, d.name
            ORDER BY d.name`
        );

        const [[payrollStats]] = await pool.query(
            `SELECT COUNT(*) total
            FROM payroll_runs
            WHERE month = MONTH(CURDATE())
            AND year = YEAR(CURDATE())`
        );

        res.json({
            role: req.user.role,

            // Dashboard summary fields
            headcount: Number(employeeStats.total || 0),
            activeEmployees: Number(employeeStats.active || 0),
            inactiveEmployees: Number(employeeStats.inactive || 0),
            exitedEmployees: Number(employeeStats.exited || 0),

            present: Number(attendanceStats.present || 0),
            late: Number(attendanceStats.late || 0),
            halfDay: Number(attendanceStats.half_day || 0),

            pendingApprovals: Number(leaveStats.pending || 0),
            departments,
            payroll: payrollStats,

            // Full statistics
            employees: employeeStats,
            attendance: attendanceStats,
            leaves: leaveStats
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({
            message: 'Could not load dashboard.'
        });
    }
});

// ==================== EXPORT ROUTER ====================

module.exports = router;
