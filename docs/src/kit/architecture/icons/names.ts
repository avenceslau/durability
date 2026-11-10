export const iconNames = [
  "durable-objects",
  "workers",
  "workflows",
  "d1",
  "r2",
  "kv",
  "queues",
  "workers-ai",
  "dynamic-workers",
  "agents",
  "user",
  "browser",
  "database",
  "clock",
  "shield",
  "trash",
] as const

export type IconName = (typeof iconNames)[number]

export function isIconName(value: unknown): value is IconName {
  return iconNames.includes(value as IconName)
}
