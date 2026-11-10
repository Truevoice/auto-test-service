const google = require('../services/auth/google_oauth')
const session = require('../services/auth/session_service')
const audit = require('../services/audit/audit_service')
const log = require('../utils/log')

const { OAUTH_REDIRECT_URI } = process.env
const OAUTH_COOKIE_TTL_MS = 10 * 60 * 1000
const OAUTH_COOKIE_PATH = '/api/qc/auth'

// URL ที่ Google ส่งผู้ใช้กลับมา ต้องตรงกับที่ลงทะเบียนไว้ใน Google Cloud Console
// ผ่าน proxy (Vite/nginx) host ที่ backend เห็นอาจไม่ใช่ของหน้าเว็บ จึงควรตั้ง OAUTH_REDIRECT_URI เสมอ
const redirectUri = (req) => {
    if (OAUTH_REDIRECT_URI) return OAUTH_REDIRECT_URI
    const proto = req.headers['x-forwarded-proto'] || req.protocol
    const host = req.headers['x-forwarded-host'] || req.headers.host
    return `${proto}://${host}/api/qc/auth/callback`
}

const oauthCookie = (value, maxAgeMs) =>
    session.cookieHeader(session.OAUTH_COOKIE, value, maxAgeMs).replace('Path=/', `Path=${OAUTH_COOKIE_PATH}`)

const toLogin = (res, error) => res.redirect(302, `/login?error=${encodeURIComponent(error)}`)

class AuthController {
    // ไปหน้า login ของ Google (?returnTo=/qc/jobs ปลายทางหลัง login)
    async login(req, res) {
        if (!google.isConfigured()) {
            log.error('Auth: Google OAuth client is not configured')
            return toLogin(res, 'NOT_CONFIGURED')
        }
        const { url, state, verifier } = google.startLogin(redirectUri(req))
        const returnTo = Buffer.from(google.safeReturnTo(req.query.returnTo)).toString('base64url')
        res.setHeader('Set-Cookie', oauthCookie(`${state}.${verifier}.${returnTo}`, OAUTH_COOKIE_TTL_MS))
        res.redirect(302, url)
    }

    // Google ส่งกลับมาพร้อม code: ตรวจ state, แลก token, ตรวจโดเมน, สร้าง session
    async callback(req, res) {
        const clearOauth = oauthCookie('', 0)
        try {
            if (req.query.error) {
                res.setHeader('Set-Cookie', clearOauth)
                return toLogin(res, 'CANCELLED')
            }
            const [state, verifier, returnTo] = String(session.parseCookies(req.headers.cookie)[session.OAUTH_COOKIE] || '').split('.')
            if (!state || !verifier || state !== req.query.state || !req.query.code) {
                res.setHeader('Set-Cookie', clearOauth)
                return toLogin(res, 'EXPIRED')
            }
            const result = await google.finishLogin({ code: String(req.query.code), verifier, redirectUri: redirectUri(req) })
            if (!result.ok) {
                await audit.record(req, 'LOGIN_DENIED', { user: { email: result.email || null }, detail: { reason: result.reason } })
                log.warn({ email: result.email, reason: result.reason }, 'Auth: login denied')
                res.setHeader('Set-Cookie', clearOauth)
                return toLogin(res, result.reason === 'DOMAIN_NOT_ALLOWED' ? 'DOMAIN' : 'DENIED')
            }
            const { token, maxAgeMs } = await session.createSession(result.user, req)
            await audit.record(req, 'LOGIN', { user: result.user })
            log.info({ email: result.user.email }, 'Auth: login')
            res.setHeader('Set-Cookie', [clearOauth, session.cookieHeader(session.SESSION_COOKIE, token, maxAgeMs)])
            res.redirect(302, google.safeReturnTo(Buffer.from(returnTo || '', 'base64url').toString('utf8')))
        } catch (e) {
            log.error({ error: 'Controller: auth callback ' + e?.message })
            res.setHeader('Set-Cookie', clearOauth)
            toLogin(res, 'FAILED')
        }
    }

    // ผู้ใช้ที่ login อยู่ (401 ถ้ายังไม่ login) หน้าเว็บใช้ตัดสินว่าจะพาไปหน้า login ไหม
    async me(req, res) {
        try {
            const user = await session.getSessionUser(req)
            if (!user) return res.status(401).json({ message: 'Login required' })
            res.json({ message: 'Success', data: { email: user.email, name: user.name, picture: user.picture } })
        } catch (e) {
            log.error({ error: 'Controller: auth me ' + e?.message })
            res.status(500).json({ message: 'Internal Server Error' })
        }
    }

    // ออกจากระบบ: ลบ session ใน DB (cookie เดิมใช้ต่อไม่ได้แม้ถูกขโมยไป) แล้วล้าง cookie
    async logout(req, res) {
        try {
            const user = await session.getSessionUser(req)
            if (user) {
                await session.deleteSession(user.session_id)
                await audit.record(req, 'LOGOUT', { user })
            }
            res.setHeader('Set-Cookie', session.cookieHeader(session.SESSION_COOKIE, '', 0))
            res.json({ message: 'Success' })
        } catch (e) {
            log.error({ error: 'Controller: auth logout ' + e?.message })
            res.status(500).json({ message: 'Internal Server Error' })
        }
    }
}

module.exports = AuthController
