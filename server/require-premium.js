const { isPremiumActiveFromUserRow } = require('./plan-limits');

function requirePremium(req, res, next) {
  if (isPremiumActiveFromUserRow(req.user)) return next();

  const wantsJson =
    (typeof req.path === 'string' && req.path.startsWith('/api/')) ||
    (req.headers.accept && req.headers.accept.includes('application/json')) ||
    req.xhr;

  if (wantsJson) {
    return res.status(403).json({
      error: 'premium_required',
      message: 'This feature is available on the Premium plan only.'
    });
  }

  return res.redirect('/app/pricing.html');
}

module.exports = requirePremium;
module.exports.requirePremium = requirePremium;
