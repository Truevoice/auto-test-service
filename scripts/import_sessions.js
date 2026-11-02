// นำไฟล์ Extended JSON จาก export_sessions.js เข้า collection sessions ของ DB บนเครื่อง (คงชนิด ObjectId/Date)
// ใช้: node scripts/import_sessions.js <ไฟล์> [--replace-broken]
//   --replace-broken  ลบ sessions ที่ _id เป็น string ก่อน (ข้อมูลที่เคย import จากไฟล์ JSON ธรรมดา)
// เขียนได้เฉพาะ DB บน localhost เท่านั้น กันเผลอเขียนทับ server จริง
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

const mongoose = require('mongoose')
const mongo = require('../db/mongo')

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1']

const assertLocalTarget = () => {
    const { MONGO_URI, MONGO_HOST = '127.0.0.1', SSH_ENABLED = 'false' } = process.env
    if (SSH_ENABLED === 'true') throw new Error('refuse to import through SSH tunnel (server DB), set SSH_ENABLED=false')
    const host = MONGO_URI ? new URL(MONGO_URI).hostname : MONGO_HOST
    if (!LOCAL_HOSTS.includes(host.replace(/^\[|\]$/g, ''))) {
        throw new Error(`refuse to import into non-local DB host: ${host}`)
    }
}

const main = async () => {
    const args = process.argv.slice(2)
    const file = args.find((a) => !a.startsWith('--'))
    if (!file) throw new Error('usage: node scripts/import_sessions.js <file> [--replace-broken]')
    assertLocalTarget()

    const { EJSON } = mongoose.mongo.BSON
    const docs = EJSON.parse(fs.readFileSync(path.resolve(file), 'utf8'), { relaxed: false })
    if (!Array.isArray(docs)) throw new Error('file must contain a JSON array')

    await mongo.connect()
    const sessions = mongoose.connection.db.collection('sessions')

    if (args.includes('--replace-broken')) {
        const { deletedCount } = await sessions.deleteMany({ _id: { $type: 'string' } })
        console.log(`removed ${deletedCount} sessions with string _id`)
    }

    // replace ตาม _id: รันซ้ำได้ ไม่เกิดแถวซ้ำ
    const result = docs.length
        ? await sessions.bulkWrite(
              docs.map((doc) => ({ replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true } })),
              { ordered: false },
          )
        : { upsertedCount: 0, modifiedCount: 0 }
    console.log(
        `imported ${docs.length} sessions into ${mongoose.connection.db.databaseName} (new ${result.upsertedCount}, replaced ${result.modifiedCount})`,
    )
}

main()
    .catch((err) => {
        console.error(err.message)
        process.exitCode = 1
    })
    .finally(() => mongo.disconnect())
