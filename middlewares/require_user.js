const { getSessionUser } = require('../services/auth/session_service')
const log = require('../utils/log')

// ทุก API ของ QC ต้อง login ก่อน (ยกเว้น /qc/auth/*) ผู้ใช้ที่ login อยู่อยู่ใน req.user
module.exports = async (req, res, next) => {
    try {
        const user = await getSessionUser(req)
        if (!user) return res.status(401).json({ message: 'Login required' })
        req.user = user
        next()
    } catch (e) {
        log.error({ error: 'Middleware: requireUser ' + e?.message })
        res.status(500).json({ message: 'Internal Server Error' })
    }
}
