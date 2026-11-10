const crypto = require('crypto')
const QcUserSession = require('../../models/qc_user_session_model')
const QcUser = require('../../models/qc_user_model')

const { SESSION_TTL_HOURS = '12', NODE_ENV } = process.env

const SESSION_COOKIE = 'qc_session'
// state + PKCE verifier ระหว่างไปหน้า login ของ Google (อายุสั้น)
const OAUTH_COOKIE = 'qc_oauth'
const TTL_MS = Number(SESSION_TTL_HOURS) * 60 * 60 * 1000

const hash = (token) => crypto.createHash('sha256').update(token).digest('hex')

// อ่าน cookie จาก header (ไม่ต้องเพิ่ม dependency)
const parseCookies = (header = '') =>
    Object.fromEntries(
        String(header)
            .split(';')
            .map((part) => part.trim())
            .filter((part) => part.includes('='))
            .map((part) => {
                const i = part.indexOf('=')
                const value = part.slice(i + 1).trim()
                try {
                    return [part.slice(0, i).trim(), decodeURIComponent(value)]
                } catch {
                    return [part.slice(0, i).trim(), value]
                }
            }),
    )

// cookie ที่ JavaScript ในหน้าเว็บอ่านไม่ได้ (httpOnly) ส่งเฉพาะ https ตอน production
const cookieHeader = (name, value, maxAgeMs) => {
    const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
    if (NODE_ENV === 'production') parts.push('Secure')
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`)
    return parts.join('; ')
}

const clientIp = (req) =>
    String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '')
        .split(',')[0]
        .trim()

const createSession = async (user, req) => {
    const token = crypto.randomBytes(32).toString('base64url')
    const now = new Date()
    await QcUserSession.create({
        _id: hash(token),
        email: user.email,
        name: user.name,
        picture: user.picture,
        ip: clientIp(req),
        user_agent: String(req.headers['user-agent'] || '').slice(0, 300),
        created_at: now,
        expires_at: new Date(now.getTime() + TTL_MS),
    })
    await QcUser.updateOne(
        { _id: user.email },
        {
            $set: { name: user.name, picture: user.picture, last_login_at: now },
            $setOnInsert: { first_login_at: now },
            $inc: { login_count: 1 },
        },
        { upsert: true },
    )
    return { token, maxAgeMs: TTL_MS }
}

// ผู้ใช้ของ request จาก cookie (null ถ้าไม่มีหรือหมดอายุ)
const getSessionUser = async (req) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (!token || token.length > 100) return null
    const session = await QcUserSession.findById(hash(token)).lean()
    if (!session || session.expires_at < new Date()) return null
    return { email: session.email, name: session.name, picture: session.picture, session_id: session._id }
}

const deleteSession = (sessionId) => QcUserSession.deleteOne({ _id: sessionId })

module.exports = {
    SESSION_COOKIE,
    OAUTH_COOKIE,
    parseCookies,
    cookieHeader,
    clientIp,
    createSession,
    getSessionUser,
    deleteSession,
}
