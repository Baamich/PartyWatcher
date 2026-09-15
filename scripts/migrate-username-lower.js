// migrate-username-lower.js — запустить один раз через node
const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const config = require('../src/config');
const User = require('../src/models/User');

(async () => {
  await mongoose.connect(config.mongoUri);
  const users = await User.find({});
  for (const u of users) {
    u.usernameLower = u.username.toLowerCase();
    await u.save({ validateBeforeSave: false });
  }
  console.log(`Обновлено: ${users.length}`);
  await mongoose.disconnect();
})();