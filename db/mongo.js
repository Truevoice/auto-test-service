const fs = require('fs')
const mongoose = require('mongoose')
const { createTunnel } = require('tunnel-ssh')
const log = require('../utils/log')
const {
    MONGO_URI,
    MONGO_HOST = '127.0.0.1',
    MONGO_PORT = '27017',
    MONGO_DB = 'auto_test',
    MONGO_AUTH_SOURCE = 'admin',
    MONGO_USER,
    MONGO_PASSWORD,
    SSH_ENABLED = 'false',
    SSH_HOST,
    SSH_PORT = '22',
    SSH_USER,
    SSH_PASSWORD,
    SSH_PRIVATE_KEY_PATH,
    SSH_PASSPHRASE,
    SSH_DST_HOST = '127.0.0.1',
    SSH_DST_PORT = '27017',
    SSH_LOCAL_PORT = '27018',
} = process.env

let tunnelServer = null
let sshClient = null

const openSshTunnel = async () => {
    const sshOptions = {
        host: SSH_HOST,
        port: Number(SSH_PORT),
        username: SSH_USER,
    }
    if (SSH_PRIVATE_KEY_PATH) {
        sshOptions.privateKey = fs.readFileSync(SSH_PRIVATE_KEY_PATH)
        if (SSH_PASSPHRASE) sshOptions.passphrase = SSH_PASSPHRASE
    } else {
        sshOptions.password = SSH_PASSWORD
    }

    const [server, client] = await createTunnel(
        { autoClose: false },
        { host: '127.0.0.1', port: Number(SSH_LOCAL_PORT) },
        sshOptions,
        { dstAddr: SSH_DST_HOST, dstPort: Number(SSH_DST_PORT) },
    )
    tunnelServer = server
    sshClient = client
    client.on('error', (err) => log.error(err, 'SSH tunnel error'))
    log.info(`SSH tunnel opened 127.0.0.1:${SSH_LOCAL_PORT} -> ${SSH_HOST} -> ${SSH_DST_HOST}:${SSH_DST_PORT}`)
}

// ใช้ MONGO_URI ถ้ามี ไม่งั้นใช้ host/port (ผ่าน SSH จะชี้ไปที่ local port ของ tunnel)
const getUri = (useSsh) => {
    if (MONGO_URI) return MONGO_URI
    if (useSsh) {
        return `mongodb://127.0.0.1:${SSH_LOCAL_PORT}/${MONGO_DB}?authSource=${MONGO_AUTH_SOURCE}&directConnection=true`
    }
    return `mongodb://${MONGO_HOST}:${MONGO_PORT}/${MONGO_DB}?authSource=${MONGO_AUTH_SOURCE}`
}

const connect = async () => {
    const useSsh = SSH_ENABLED === 'true'
    if (useSsh) await openSshTunnel()

    mongoose.connection.on('error', (err) => log.error(err, 'MongoDB error'))
    mongoose.connection.on('disconnected', () => log.warn('MongoDB disconnected'))

    const options = { serverSelectionTimeoutMS: 10000 }
    // MONGO_URI มี user/pass ของตัวเองอยู่แล้ว ใส่ MONGO_USER ทับจะ login ผิด user (Authentication failed)
    if (MONGO_USER && !MONGO_URI) {
        options.user = MONGO_USER
        options.pass = MONGO_PASSWORD
    }
    await mongoose.connect(getUri(useSsh), options)
    log.info('MongoDB connected')
}

const disconnect = async () => {
    await mongoose.disconnect()
    if (tunnelServer) tunnelServer.close()
    if (sshClient) sshClient.end()
}

module.exports = { connect, disconnect }
