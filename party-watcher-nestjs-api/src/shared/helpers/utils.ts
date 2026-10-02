import { LoggerScope } from '../enums/logger-scope.enum.js'

export const formatedlogscope = (
  scope: (typeof LoggerScope)[keyof typeof LoggerScope],
) => {
  return `[${scope}]`
}
