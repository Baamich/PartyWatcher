const User = require('../models/User');
const { isAdminRole } = require('../services/roles');

// роль — из базы (в токене может быть старая); req.adminRole — admin | owner, для проверок прав дальше
async function adminOnly(req, res, next) {
  const user = await User.findById(req.user.id).select('role').lean();
  if (!user || !isAdminRole(user.role)) {
    return res.status(403).json({ error: req.t('server.adminOnly') });
  }
  req.adminRole = user.role;
  next();
}

// только владелец сайта: обновление, назначение ролей
async function ownerOnly(req, res, next) {
  const user = await User.findById(req.user.id).select('role').lean();
  if (!user || user.role !== 'owner') {
    return res.status(403).json({ error: req.t('server.ownerOnly') });
  }
  req.adminRole = user.role;
  next();
}

module.exports = adminOnly;
module.exports.owner = ownerOnly;
