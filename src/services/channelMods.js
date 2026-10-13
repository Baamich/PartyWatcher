// channelMods.js — модераторы канала и их права.
// Права обычного модератора — только чат; «эфирные» (название, категория, рейд) — только у высшего.
// Что из этого разрешено, решает стример (User.modPerms); без настройки — DEFAULT_PERMS.
// Роли канала кэшируются в памяти на минуту (чат спрашивает на каждое сообщение), при изменении — сброс
const User = require('../models/User');
const ChannelMod = require('../models/ChannelMod');

const CHAT_PERMS = ['deleteMsg', 'timeout', 'ban', 'clearChat', 'chatSettings'];
const STREAM_PERMS = ['editTitle', 'editCategory', 'raid'];
const ALL_PERMS = [...CHAT_PERMS, ...STREAM_PERMS];
const DEFAULT_PERMS = {
  mod: ['deleteMsg', 'timeout'],
  senior: ['deleteMsg', 'timeout', 'ban', 'clearChat', 'chatSettings', 'editTitle', 'editCategory', 'raid'],
};
const MAX_MODS = 50;
const RANK = { owner: 3, senior: 2, mod: 1 };

const cache = new Map(); // nameLower → { at, ownerId, mods: Map<userId, { level, username }>, perms }
const TTL = 60 * 1000;

function cleanPerms(raw) {
  const pick = (arr, allowed) => (Array.isArray(arr) ? [...new Set(arr.filter((p) => allowed.includes(p)))] : null);
  return {
    mod: pick(raw?.mod, CHAT_PERMS) ?? DEFAULT_PERMS.mod,
    senior: pick(raw?.senior, ALL_PERMS) ?? DEFAULT_PERMS.senior,
  };
}

async function load(nameLower) {
  const hit = cache.get(nameLower);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const owner = await User.findOne({ streamerNameLower: nameLower }).select('_id modPerms').lean();
  const rows = owner ? await ChannelMod.find({ streamerNameLower: nameLower }).select('userId level username').lean() : [];
  const entry = {
    at: Date.now(),
    ownerId: owner ? String(owner._id) : null,
    mods: new Map(rows.map((r) => [String(r.userId), { level: r.level, username: r.username }])),
    perms: cleanPerms(owner?.modPerms),
  };
  if (cache.size > 2000) cache.clear();
  cache.set(nameLower, entry);
  return entry;
}

function invalidate(nameLower) {
  cache.delete(nameLower);
}

// 'owner' | 'senior' | 'mod' | null
async function roleOf(nameLower, userId) {
  if (!userId) return null;
  const e = await load(nameLower);
  if (e.ownerId && e.ownerId === String(userId)) return 'owner';
  return e.mods.get(String(userId))?.level || null;
}

// { role, perms: [...] } — у владельца все права
async function permsOf(nameLower, userId) {
  const role = await roleOf(nameLower, userId);
  if (role === 'owner') return { role, perms: [...ALL_PERMS] };
  if (!role) return { role: null, perms: [] };
  const e = await load(nameLower);
  return { role, perms: [...e.perms[role]] };
}

async function can(nameLower, userId, perm) {
  const p = await permsOf(nameLower, userId);
  return p.perms.includes(perm);
}

// наказывать можно только тех, кто ниже по рангу (модер не банит модера, никто не трогает стримера)
async function outranks(nameLower, actorId, targetId) {
  const a = await roleOf(nameLower, actorId);
  const b = await roleOf(nameLower, targetId);
  return (RANK[a] || 0) > (RANK[b] || 0);
}

// уровень модератора для значка в чате (по кэшу; владельца отмечает isOwner)
async function badgeOf(nameLower, userId) {
  if (!userId) return null;
  const e = await load(nameLower);
  return e.mods.get(String(userId))?.level || null;
}

module.exports = {
  CHAT_PERMS, STREAM_PERMS, ALL_PERMS, DEFAULT_PERMS, MAX_MODS,
  cleanPerms, load, invalidate, roleOf, permsOf, can, outranks, badgeOf,
};
