import * as crypto from 'node:crypto'

import { LoggerScope } from '../enums/logger-scope.enum.js'

export const formatedlogscope = (
  scope: (typeof LoggerScope)[keyof typeof LoggerScope],
) => {
  return `[${scope}]`
}

export const generateHexCode = (length: number = 8) => {
  const normalizedLength = length / 2

  return crypto.randomBytes(normalizedLength).toString('hex')
}
