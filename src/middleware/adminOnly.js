const User = require('../models/User');

async function adminOnly(req, res, next) {
  const user = await User.findById(req.user.id).select('role');
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'Только для администратора' });
  }
  next();
}

module.exports = adminOnly;