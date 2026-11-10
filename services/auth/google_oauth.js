const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// Login ด้วย Google (OAuth 2.0 authorization code + PKCE) ฝั่ง server เท่านั้น
// client secret และ token ของ Google ไม่เคยไปถึงเบราว์เซอร์ หน้าเว็บได้แค่ cookie session ของระบบเรา
const {
    GOOGLE_OAUTH_CLIENT_FILE = 'google-oauth-client.json',
    GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET,
    OAUTH_ALLOWED_DOMAIN = 'accentix.ai',
} = process.env

const AUTH_URI = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_URI = 'https://oauth2.googleapis.com/token'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
// ขอแค่ตัวตน (อีเมล ชื่อ รูป) ไม่ขอสิทธิ์อ่าน Gmail หรือข้อมูลอื่น
const SCOPES = ['openid', 'email', 'profile']

let client = null

// client id/secret จาก env หรือจากไฟล์ที่ดาวน์โหลดจาก Google Cloud Console (วางไว้ใน key/ ไม่อยู่ใน git)
const getClient = () => {
    if (client) return client
    if (GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET) {
        client = { id: GOOGLE_OAUTH_CLIENT_ID, secret: GOOGLE_OAUTH_CLIENT_SECRET }
        return client
    }
    const file = path.isAbsolute(GOOGLE_OAUTH_CLIENT_FILE)
        ? GOOGLE_OAUTH_CLIENT_FILE
        : path.join(__dirname, '../../key', GOOGLE_OAUTH_CLIENT_FILE)
    if (!fs.existsSync(file)) return null
    const json = JSON.parse(fs.readFileSync(file, 'utf8'))
    const web = json.web || json.installed
    if (!web?.client_id || !web?.client_secret) return null
    client = { id: web.client_id, secret: web.client_secret }
    return client
}

const isConfigured = () => Boolean(getClient())

const b64url = (buf) => buf.toString('base64url')

// เริ่ม login: สร้าง state (กันการปลอม callback) และ PKCE verifier แล้วคืน URL ของหน้า login Google
const startLogin = (redirectUri) => {
    const state = b64url(crypto.randomBytes(16))
    const verifier = b64url(crypto.randomBytes(32))
    const params = new URLSearchParams({
        client_id: getClient().id,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: SCOPES.join(' '),
        state,
        code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        // ให้ Google แสดงเฉพาะบัญชีของบริษัท (ยังตรวจซ้ำที่ server เสมอ)
        hd: OAUTH_ALLOWED_DOMAIN,
        prompt: 'select_account',
    })
    return { url: `${AUTH_URI}?${params}`, state, verifier }
}

const decodeJwtPayload = (jwt) => {
    const part = String(jwt || '').split('.')[1]
    if (!part) throw new Error('missing id_token')
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

// ตรวจข้อมูลผู้ใช้ใน id_token: ออกโดย Google ให้ client นี้ ยังไม่หมดอายุ อีเมลยืนยันแล้ว และเป็นโดเมนบริษัท
// id_token ได้มาจาก token endpoint ของ Google โดยตรงผ่าน HTTPS จึงไม่ต้องตรวจลายเซ็นซ้ำ (ตามข้อกำหนด OpenID Connect)
// คืน { ok: true, user } หรือ { ok: false, reason, email }
const checkIdToken = (claims, { clientId, domain = OAUTH_ALLOWED_DOMAIN, now = Date.now() } = {}) => {
    const email = String(claims?.email || '').toLowerCase()
    if (!ISSUERS.includes(claims?.iss)) return { ok: false, reason: 'BAD_ISSUER', email }
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!aud.includes(clientId)) return { ok: false, reason: 'BAD_AUDIENCE', email }
    if (!claims.exp || claims.exp * 1000 < now - 60_000) return { ok: false, reason: 'EXPIRED', email }
    if (claims.email_verified !== true && claims.email_verified !== 'true') {
        return { ok: false, reason: 'EMAIL_NOT_VERIFIED', email }
    }
    // hd = โดเมนของ Google Workspace บัญชี gmail.com ทั่วไปไม่มี hd
    const allowed = domain.toLowerCase()
    if (claims.hd !== allowed || !email.endsWith(`@${allowed}`)) return { ok: false, reason: 'DOMAIN_NOT_ALLOWED', email }
    return { ok: true, user: { email, name: claims.name || email, picture: claims.picture || null } }
}

// แลก code เป็น token แล้วตรวจผู้ใช้
const finishLogin = async ({ code, verifier, redirectUri }) => {
    const { id, secret } = getClient()
    const res = await fetch(TOKEN_URI, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: id,
            client_secret: secret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: verifier,
        }),
        signal: AbortSignal.timeout(15_000),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
        const e = new Error(`token exchange failed: ${body.error || res.status}`)
        e.reason = 'TOKEN_EXCHANGE_FAILED'
        throw e
    }
    // ไม่เก็บ access/refresh token ของ Google เพราะใช้แค่ยืนยันตัวตนครั้งเดียว
    return checkIdToken(decodeJwtPayload(body.id_token), { clientId: id })
}

// ปลายทางหลัง login ต้องเป็น path ในเว็บเราเท่านั้น (กันพาไปเว็บอื่น)
const safeReturnTo = (value) => {
    const s = String(value || '')
    if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\') || s.startsWith('/api/') || s.length > 500) {
        return '/'
    }
    return s
}

module.exports = { isConfigured, startLogin, finishLogin, checkIdToken, decodeJwtPayload, safeReturnTo, OAUTH_ALLOWED_DOMAIN }
