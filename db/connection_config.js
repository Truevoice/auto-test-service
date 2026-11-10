const fs = require('fs')
const { createTunnel } = require('tunnel-ssh')
const log = require('../utils/log')

// อ่านค่าเชื่อมต่อ Mongo (+ SSH tunnel) จาก env ตาม prefix เช่น '' = MONGO_*/SSH_*, 'SOURCE_' = SOURCE_MONGO_*/SOURCE_SSH_*
// ค่าพวกนี้ใช้ใน server เท่านั้น ห้ามส่งออกไปทาง API
const readConfig = (prefix = '', defaults = {}) => {
    const env = (key, fallback) => {
        const value = process.env[`${prefix}${key}`]
        return value === undefined || value === '' ? fallback : value
    }
    return {
        uri: env('MONGO_URI'),
        host: env('MONGO_HOST', defaults.host),
        port: env('MONGO_PORT', '27017'),
        db: env('MONGO_DB', defaults.db),
        authSource: env('MONGO_AUTH_SOURCE', 'admin'),
        user: env('MONGO_USER'),
        password: env('MONGO_PASSWORD'),
        ssh: {
            enabled: env('SSH_ENABLED', 'false') === 'true',
            host: env('SSH_HOST'),
            port: env('SSH_PORT', '22'),
            user: env('SSH_USER'),
            password: env('SSH_PASSWORD'),
            privateKeyPath: env('SSH_PRIVATE_KEY_PATH'),
            passphrase: env('SSH_PASSPHRASE'),
            dstHost: env('SSH_DST_HOST', '127.0.0.1'),
            dstPort: env('SSH_DST_PORT', '27017'),
            localPort: env('SSH_LOCAL_PORT', defaults.localPort || '27018'),
        },
    }
}

// เปิด SSH tunnel: 127.0.0.1:localPort -> ssh host -> dstHost:dstPort คืน close()
const openTunnel = async (ssh, label = 'SSH tunnel') => {
    const sshOptions = { host: ssh.host, port: Number(ssh.port), username: ssh.user }
    if (ssh.privateKeyPath) {
        sshOptions.privateKey = fs.readFileSync(ssh.privateKeyPath)
        if (ssh.passphrase) sshOptions.passphrase = ssh.passphrase
    } else {
        sshOptions.password = ssh.password
    }
    const [server, client] = await createTunnel(
        { autoClose: false },
        { host: '127.0.0.1', port: Number(ssh.localPort) },
        sshOptions,
        { dstAddr: ssh.dstHost, dstPort: Number(ssh.dstPort) },
    )
    client.on('error', (err) => log.error({ error: err.message }, `${label} error`))
    log.info(`${label} opened on 127.0.0.1:${ssh.localPort}`)
    return () => {
        server.close()
        client.end()
    }
}

// ใช้ URI ถ้ามี ไม่งั้นใช้ host/port (ผ่าน SSH จะชี้ไปที่ local port ของ tunnel)
const buildUri = (config) => {
    if (config.uri) return config.uri
    if (config.ssh.enabled) {
        return `mongodb://127.0.0.1:${config.ssh.localPort}/${config.db}?authSource=${config.authSource}&directConnection=true`
    }
    return `mongodb://${config.host}:${config.port}/${config.db}?authSource=${config.authSource}`
}

// MONGO_URI มี user/pass ของตัวเองอยู่แล้ว ใส่ user ทับจะ login ผิด user (Authentication failed)
const buildOptions = (config) => {
    const options = { serverSelectionTimeoutMS: 10000 }
    if (config.user && !config.uri) {
        options.user = config.user
        options.pass = config.password
    }
    return options
}

module.exports = { readConfig, openTunnel, buildUri, buildOptions }
