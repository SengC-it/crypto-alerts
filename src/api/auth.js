// Shared authentication for scheduled serverless endpoints.

export function authorizeCronRequest(
  req,
  secret = process.env.CRON_SECRET,
  {
    requireConfigured = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production',
  } = {},
) {
  if (!secret) {
    return requireConfigured
      ? { authorized: false, configured: false, reason: 'CRON_SECRET is not configured' }
      : { authorized: true, configured: false };
  }
  const authorization = req?.headers?.authorization || req?.headers?.Authorization;
  if (authorization === 'Bearer ' + secret) {
    return { authorized: true, configured: true };
  }
  return { authorized: false, configured: true, reason: 'Invalid CRON_SECRET' };
}
