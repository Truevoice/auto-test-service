const mongoose = require('mongoose')
const log = require('../utils/log')
const { readConfig, openTunnel, buildUri, buildOptions } = require('./connection_config')

// ฐานข้อมูลต้นทางของ data-pipeline (SOURCE_MONGO_* / SOURCE_SSH_*) อ่านอย่างเดียว
// ค่าเชื่อมต่อมาจาก env เท่านั้น ไม่แสดงในหน้าเว็บหรือ API
const config = () => readConfig('SOURCE_', { localPort: '27019' })

const isConfigured = () => {
    const c = config()
    return Boolean(c.uri || (c.host && c.db))
}

const normalize = (uri) => String(uri || '').replace(/\/\/[^@/]*@/, '//').replace(/\/+$/, '').toLowerCase()

// เปิดการเชื่อมต่อเฉพาะตอนรอบทำงาน แล้วปิดทั้ง connection และ tunnel หลังจบ (ไม่ค้าง SSH ไว้ตลอด)
// คืน { db, close }
const openSource = async (targetUri) => {
    const c = config()
    if (!isConfigured()) {
        const e = new Error('source database is not configured')
        e.code = 'NOT_CONFIGURED'
        throw e
    }
    const uri = buildUri(c)
    // ฐานเดียวกับฐาน eval (ไม่ผ่าน SSH): ดึงมาทับตัวเองไม่มีประโยชน์และเสี่ยงข้อมูลหาย
    if (!c.ssh.enabled && targetUri && normalize(uri) === normalize(targetUri)) {
        const e = new Error('source database is the same as the eval database')
        e.code = 'SAME_DATABASE'
        throw e
    }
    let closeTunnel = null
    let conn = null
    try {
        if (c.ssh.enabled) closeTunnel = await openTunnel(c.ssh, 'Pipeline SSH tunnel')
        conn = await mongoose.createConnection(uri, buildOptions(c)).asPromise()
    } catch (e) {
        if (closeTunnel) closeTunnel()
        throw e
    }
    conn.on('error', (err) => log.error({ error: err.message }, 'Pipeline source DB error'))
    log.info('Pipeline: source DB connected')
    return {
        db: conn.db,
        close: async () => {
            await conn.close().catch(() => {})
            if (closeTunnel) closeTunnel()
            log.info('Pipeline: source DB closed')
        },
    }
}

module.exports = { isConfigured, openSource }
