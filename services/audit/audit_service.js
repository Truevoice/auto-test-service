const mongoose = require('mongoose')
const QcAuditLog = require('../../models/qc_audit_log_model')
const QcUser = require('../../models/qc_user_model')
const { clientIp } = require('../auth/session_service')
const log = require('../../utils/log')

const ACTIONS = ['LOGIN', 'LOGIN_DENIED', 'LOGOUT', 'RUN_START', 'CONFIG_UPDATE', 'FILE_UPDATE', 'VIEW_CALL', 'PIPELINE_START', 'PIPELINE_CONFIG_UPDATE']

// บันทึกว่าใครทำอะไร ไม่ให้การบันทึกที่พลาดทำให้งานหลักพัง (log error ไว้แทน)
// user ไม่ส่งมาใช้ req.user (ผู้ใช้ที่ login อยู่)
const record = async (req, action, { target, detail, user = req.user } = {}) => {
    try {
        await QcAuditLog.create({
            at: new Date(),
            email: user?.email || null,
            name: user?.name || null,
            action,
            target: target == null ? undefined : String(target),
            detail,
            ip: clientIp(req),
            user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
        })
    } catch (e) {
        log.error({ action, error: e.message }, 'Audit: record failed')
    }
}

// ประวัติใหม่ก่อน แบ่งชุดด้วย before = _id ของรายการสุดท้ายที่หน้าเว็บมีแล้ว
const listAudit = async ({ email, action, before, limit = 50 } = {}) => {
    const filter = {}
    if (email) filter.email = email
    if (action) filter.action = action
    if (before && mongoose.isValidObjectId(before)) filter._id = { $lt: new mongoose.Types.ObjectId(String(before)) }
    // ใช้ index ที่ตรงกับตัวกรอง (DB เปิด notablescan)
    let query = QcAuditLog.find(filter, { user_agent: 0 }).sort({ _id: -1 }).limit(limit + 1)
    if (email) query = query.hint({ email: 1, _id: -1 })
    else if (action) query = query.hint({ action: 1, _id: -1 })
    const found = await query.lean()
    const items = found.slice(0, limit)
    return { items, next_before: found.length > limit ? items[items.length - 1]._id : null }
}

// ผู้ใช้ที่เคย login ใช้เป็นตัวกรองในหน้าประวัติการใช้งาน
const listUsers = () => QcUser.find({}).sort({ last_login_at: -1 }).limit(500).lean()

module.exports = { ACTIONS, record, listAudit, listUsers }
