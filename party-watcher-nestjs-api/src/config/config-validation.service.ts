import Joi, { ObjectSchema } from 'joi'

import { EnvParam } from '../shared/enums/env.enum.js'

export class ConfigValidationService {
  public static getValidationSchema(): ObjectSchema<typeof EnvParam> {
    return Joi.object({
      NODE_ENV: Joi.string()
        .valid('development', 'production', 'test', 'debug')
        .default('development'),

      PORT: Joi.number().port().default(3000),
      ADMIN_PORT: Joi.number().port().default(3001),

      PUBLIC_URL: Joi.string().uri().required(),

      MONGO_URI: Joi.string().uri().required(),

      JWT_SECRET: Joi.string().required(),
      JWT_EXPIRES_IN: Joi.string().default('7d'),
      FORCE_SECURE_COOKIE: Joi.boolean().truthy('1').falsy('0').default(false),
      COOKIE_DOMAIN: Joi.string().allow('').default('.partywatcher.de'),

      UPLOAD_DIR: Joi.string().default('uploads'),
      MAX_UPLOAD_SIZE_MB: Joi.number().default(10240),
      UPLOAD_TTL_DAYS: Joi.number().default(30),

      GITHUB_REPO_URL: Joi.string().uri(),
      GITHUB_BRANCH: Joi.string().default('main'),
      GITHUB_TOKEN: Joi.string(),
      UPDATE_SECRET_KEY: Joi.string(),

      GOOGLE_DRIVE_API_KEY: Joi.string(),

      YT_CACHE_DIR: Joi.string().default('/home/ubuntu/PartyWatcher/yt-cache'),
      THUMB_DIR: Joi.string().default('/home/ubuntu/PartyWatcher/thumbnails'),
    })
  }
}
