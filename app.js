const path = require('path')
require('dotenv').config({path: path.join(__dirname, '.env')})
const { PORT = '3000' } = process.env
const log = require('./utils/log')
const mongo = require('./db/mongo')
const express = require('express')
const app = express()

require('./setup/index')(app)

const { QC_SHUTDOWN_GRACE_MS = '25000' } = process.env
let closing = false
// ปิดระบบ (deploy/Ctrl+C): ให้รอบตรวจหยุดหยิบสายใหม่ และรอสายที่กำลังตรวจจบก่อน ส่งสัญญาณซ้ำ = ปิดทันที
const shutdown = async (signal) => {
    if (closing) process.exit(1)
    closing = true
    log.info({ signal }, 'Shutting down')
    try {
        await Promise.all([
            require('./services/qc/qc_job').shutdown(Number(QC_SHUTDOWN_GRACE_MS)),
            require('./services/pipeline/pipeline_job').shutdown(Number(QC_SHUTDOWN_GRACE_MS)),
        ])
        await mongo.disconnect()
    } catch (e) {
        log.error(e, 'Shutdown error')
    }
    process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

;(async () => {
    try {
        await mongo.connect()
        await require('./models/qc_session_model').init()
        await require('./models/qc_job_run_model').init()
        await require('./models/qc_job_run_call_model').init()
        await require('./models/qc_user_model').init()
        await require('./models/qc_user_session_model').init()
        await require('./models/qc_audit_log_model').init()
        await require('./models/pipeline_run_model').init()
        await require('./services/qc/run_calls_migration').migrateRunCalls()
        // ค่าตั้งที่แก้จากหน้าเว็บ ต้องโหลดก่อนตั้ง cron
        await require('./services/qc/qc_settings').loadSettings()
        await require('./services/qc/qc_files').loadFiles()
        await require('./services/qc/qc_job').start()
        // data-pipeline: ฐานต้นทางต่อเฉพาะตอนรอบทำงาน ต่อไม่ได้ก็แค่รอบนั้นไม่สำเร็จ ระบบยังเปิดได้
        await require('./services/pipeline/pipeline_settings').loadSettings()
        await require('./services/pipeline/pipeline_job').start()
    } catch (err) {
        log.error(err, 'Failed to start (MongoDB / QC job)')
        process.exit(1)
    }
    app.listen(PORT, () => {
        log.info(`Server is running on port ${PORT}`)
    })
})()
