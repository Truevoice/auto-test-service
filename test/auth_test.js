const { expect } = require('chai')
const { checkIdToken, decodeJwtPayload, safeReturnTo } = require('../services/auth/google_oauth')
const { parseCookies, cookieHeader } = require('../services/auth/session_service')

const NOW = Date.UTC(2026, 10, 10, 3, 0, 0)
const CLIENT = 'client-123.apps.googleusercontent.com'
const claims = (over = {}) => ({
    iss: 'https://accounts.google.com',
    aud: CLIENT,
    exp: Math.floor(NOW / 1000) + 3600,
    email: 'somchai@accentix.ai',
    email_verified: true,
    hd: 'accentix.ai',
    name: 'Somchai',
    ...over,
})
const check = (over) => checkIdToken(claims(over), { clientId: CLIENT, domain: 'accentix.ai', now: NOW })

describe('auth: Google id_token check', () => {
    it('accepts a verified company account', () => {
        const r = check()
        expect(r.ok).to.equal(true)
        expect(r.user).to.deep.equal({ email: 'somchai@accentix.ai', name: 'Somchai', picture: null })
    })

    it('rejects other domains, personal gmail and look-alike domains', () => {
        expect(check({ email: 'x@gmail.com', hd: undefined }).reason).to.equal('DOMAIN_NOT_ALLOWED')
        expect(check({ email: 'x@other.com', hd: 'other.com' }).reason).to.equal('DOMAIN_NOT_ALLOWED')
        expect(check({ email: 'x@evilaccentix.ai', hd: 'accentix.ai' }).reason).to.equal('DOMAIN_NOT_ALLOWED')
        // hd ตรงแต่อีเมลไม่ใช่ของโดเมน
        expect(check({ email: 'x@gmail.com' }).reason).to.equal('DOMAIN_NOT_ALLOWED')
    })

    it('rejects tokens for another client, another issuer, expired or unverified email', () => {
        expect(check({ aud: 'someone-else' }).reason).to.equal('BAD_AUDIENCE')
        expect(check({ iss: 'https://evil.example' }).reason).to.equal('BAD_ISSUER')
        expect(check({ exp: Math.floor(NOW / 1000) - 3600 }).reason).to.equal('EXPIRED')
        expect(check({ email_verified: false }).reason).to.equal('EMAIL_NOT_VERIFIED')
    })

    it('lowercases the email', () => {
        expect(check({ email: 'Somchai@Accentix.AI' }).user.email).to.equal('somchai@accentix.ai')
    })

    it('decodes the JWT payload', () => {
        const jwt = ['h', Buffer.from(JSON.stringify({ email: 'a@accentix.ai' })).toString('base64url'), 's'].join('.')
        expect(decodeJwtPayload(jwt).email).to.equal('a@accentix.ai')
        expect(() => decodeJwtPayload('nope')).to.throw()
    })
})

describe('auth: return path and cookies', () => {
    it('only returns to paths inside this site', () => {
        expect(safeReturnTo('/qc/jobs?run=1')).to.equal('/qc/jobs?run=1')
        for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '', '/api/qc/run']) {
            expect(safeReturnTo(bad)).to.equal('/')
        }
    })

    it('parses cookies and builds an httpOnly cookie', () => {
        expect(parseCookies('a=1; qc_session=abc%3D; bad')).to.deep.equal({ a: '1', qc_session: 'abc=' })
        const header = cookieHeader('qc_session', 'tok', 3600_000)
        expect(header).to.include('HttpOnly').and.include('SameSite=Lax').and.include('Max-Age=3600').and.include('Path=/')
    })
})
