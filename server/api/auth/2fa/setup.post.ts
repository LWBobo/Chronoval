import QRCode from 'qrcode'
import { prepareTwoFactor } from '../../../services/users/two-factor'

export default eventHandler(async (event) => {
  const actor = await requireAccess(event, 'user')
  const user = prepareTwoFactor(actor)
  if (!user) {
    throw createError({ statusCode: 404, message: 'User not found' })
  }

  // 已开启：不再暴露/重置密钥
  if (user.totpEnabled) {
    return { enabled: true, secret: null as string | null, otpauth: null as string | null, qr: null as string | null }
  }

  // 复用尚未确认的 pending secret，保证刷新页面后二维码一致
  const secret = user.totpSecret!

  const account = user.email || user.username
  const otpauth = buildTotpUri({ secret, account, issuer: 'Chronoval' })
  const qr = await QRCode.toDataURL(otpauth, {
    width: 240,
    margin: 1,
    errorCorrectionLevel: 'M',
  })

  return {
    enabled: false,
    secret,
    otpauth,
    qr,
    account,
  }
})
