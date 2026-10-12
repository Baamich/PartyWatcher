export const VideoType = {
  YOUTUBE: 'youtube',
  TWITCH: 'twitch',
  VK: 'vk',
  DRIVE: 'drive',
  PLAYER_CAPTURE: 'player_capture',
  DIRECT: 'direct',
} as const

export type VideoType = (typeof VideoType)[keyof typeof VideoType]
