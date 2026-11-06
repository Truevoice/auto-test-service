const path = require('path')
require('dotenv').config({path: path.join(__dirname, '.env')})
const { PORT = '3000' } = process.env
const log = require('./utils/log')
const mongo = require('./db/mongo')
const express = require('express')
const app = express()

require('./setup/index')(app)

const shutdown = async () => {
    await mongo.disconnect()
    process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

;(async () => {
    try {
        await mongo.connect()
        await require('./models/qc_session_model').init()
        await require('./models/qc_job_run_model').init()
        // ค่าตั้งที่แก้จากหน้าเว็บ ต้องโหลดก่อนตั้ง cron
        await require('./services/qc/qc_settings').loadSettings()
        await require('./services/qc/qc_files').loadFiles()
        await require('./services/qc/qc_job').start()
    } catch (err) {
        log.error(err, 'Failed to start (MongoDB / QC job)')
        process.exit(1)
    }
    app.listen(PORT, () => {
        log.info(`Server is running on port ${PORT}`)
    })
})()
