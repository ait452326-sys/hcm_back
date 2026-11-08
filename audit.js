const pool = require('./db');

async function audit(
    actor,
    action,
    entity,
    entityId,
    beforeData = null,
    afterData = null,
    conn = pool
) {
    await conn.execute(
        `INSERT INTO audit_logs
        (actor_user_id, action, entity, entity_id, before_json, after_json)
        VALUES (?, ?, ?, ?, ?, ?)`,
        [
            actor,
            action,
            entity,
            entityId,
            beforeData === null ? null : JSON.stringify(beforeData),
            afterData === null ? null : JSON.stringify(afterData)
        ]
    );
}

module.exports = audit;

