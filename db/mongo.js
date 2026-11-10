const mongoose = require('mongoose')
const log = require('../utils/log')
const { readConfig, openTunnel, buildUri, buildOptions } = require('./connection_config')

// ฐานข้อมูลหลักของระบบ eval (MONGO_* / SSH_*)
const config = readConfig('', { host: '127.0.0.1', db: 'auto_test', localPort: '27018' })

let closeTunnel = null

const connect = async () => {
    // เปิด tunnel เสมอเมื่อ SSH_ENABLED (MONGO_URI อาจชี้มาที่ local port ของ tunnel เอง)
    if (config.ssh.enabled) closeTunnel = await openTunnel(config.ssh, 'SSH tunnel')

    mongoose.connection.on('error', (err) => log.error(err, 'MongoDB error'))
    mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'))

    await mongoose.connect(buildUri(config), buildOptions(config))
    log.info('MongoDB connected')
}

const disconnect = async () => {
    await mongoose.disconnect()
    if (closeTunnel) closeTunnel()
}

// ใช้กันไม่ให้ data-pipeline ดึงข้อมูลจากฐานเดียวกันมาทับตัวเอง
const targetUri = () => buildUri(config)

module.exports = { connect, disconnect, targetUri }
