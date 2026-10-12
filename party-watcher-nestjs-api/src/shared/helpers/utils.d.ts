import { LoggerScope } from '../enums/logger-scope.enum.js'
export declare const formatedlogscope: (
  scope: (typeof LoggerScope)[keyof typeof LoggerScope],
) => string
