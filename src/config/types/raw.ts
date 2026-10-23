/*
 * Input before a check proves anything about it: config as the user wrote it, an x-* tag, a file
 * oat wrote and reads back. It is read by the keys of the type it becomes, so a misspelled key
 * fails to compile, while every value stays `unknown` until a check narrows it. Maps whose keys
 * are data (scheme names, principal ids, header names) stay `Record<string, unknown>`, iterated,
 * never read by name.
 */

/** Every key of every member of a union, where `keyof` alone keeps only the shared ones. */
export type AllKeys<U> = U extends unknown ? keyof U : never

/** Config section `T` as written: the keys `T` declares, each optional and unchecked. */
export type RawOf<T> = { [K in keyof T]?: unknown }

/** A union config shape (a recipe of any kind, a step of any kind) as written: every member's keys, unchecked. */
export type RawOfUnion<U> = { [K in AllKeys<U>]?: unknown }

const isPlainObject = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value)

/** A plain object, read as config section `T`: nothing about its values is assumed. */
export const isRaw = <T>(value: unknown): value is RawOf<T> => isPlainObject(value)

/** A plain object, read as a union config shape: every member's keys, nothing about its values assumed. */
export const isRawUnion = <U>(value: unknown): value is RawOfUnion<U> => isPlainObject(value)

/** A plain object whose keys the user chose (a map of schemes, principals, headers), for iterating them. */
export const isRecord = (value: unknown): value is Record<string, unknown> => isPlainObject(value)
