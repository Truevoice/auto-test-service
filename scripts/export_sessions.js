// ดึง sessions ของวันเดียว (ตาม _id) ออกมาเป็นไฟล์ Extended JSON ไม่เอา session_logs
// ใช้: node scripts/export_sessions.js [YYYY-MM-DD] [ไฟล์ปลายทาง]
// ไม่ใส่วันที่ = วันนี้ (ตามเวลาเครื่อง), ไม่ใส่ไฟล์ = exports/sessions_<วันที่>.json
// ดึงจาก server ขณะที่ .env ชี้ DB บนเครื่อง: MONGO_URI= SSH_ENABLED=true node scripts/export_sessions.js
const fs = require('fs')
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })

// เปิด tunnel ของตัวเองคนละ port กับ dev server/เครื่อง จะได้ไม่ชนกัน (ต้องตั้งก่อน require db/mongo)
process.env.SSH_LOCAL_PORT = process.env.EXPORT_SSH_LOCAL_PORT || '27029'

const mongoose = require('mongoose')
const mongo = require('../db/mongo')

const ROOT = path.join(__dirname, '..')

const dayRange = (dateText) => {
    const start = dateText ? new Date(`${dateText}T00:00:00`) : new Date()
    if (Number.isNaN(start.getTime())) throw new Error(`invalid date: ${dateText} (use YYYY-MM-DD)`)
    start.setHours(0, 0, 0, 0)
    const end = new Date(start)
    end.setDate(end.getDate() + 1)
    return { start, end }
}

const localDate = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

const main = async () => {
    const [dateText, outArg] = process.argv.slice(2)
    const { start, end } = dayRange(dateText)
    const out = path.resolve(ROOT, outArg || `exports/sessions_${localDate(start)}.json`)

    await mongo.connect()
    const { ObjectId } = mongoose.mongo
    const cursor = mongoose.connection.db
        .collection('sessions')
        .find({
            _id: {
                $gte: ObjectId.createFromTime(Math.floor(start.getTime() / 1000)),
                $lt: ObjectId.createFromTime(Math.floor(end.getTime() / 1000)),
            },
        })
        .project({ session_logs: 0 })
        .sort({ _id: -1 })

    // เขียนทีละ document ไม่โหลดทั้งวันเข้าหน่วยความจำ
    // ใช้ EJSON ไม่ใช่ JSON.stringify: ObjectId/Date ออกมาเป็น {"$oid"} / {"$date"} import กลับแล้วได้ชนิดเดิม
    // (JSON ธรรมดากลายเป็น string แล้ว query ตามวันที่หรือ $lookup ด้วย _id จะหาไม่เจอ)
    const { EJSON } = mongoose.mongo.BSON
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const file = fs.createWriteStream(out)
    let count = 0
    file.write('[\n')
    for await (const doc of cursor) {
        if (count > 0) file.write(',\n')
        file.write(EJSON.stringify(doc, null, 2, { relaxed: true }))
        count++
    }
    file.write('\n]\n')
    await new Promise((resolve, reject) => file.end((err) => (err ? reject(err) : resolve())))

    console.log(`exported ${count} sessions (${start.toISOString()} – ${end.toISOString()}) -> ${path.relative(ROOT, out)}`)
}

main()
    .catch((err) => {
        console.error(err.message)
        process.exitCode = 1
    })
    .finally(() => mongo.disconnect())
